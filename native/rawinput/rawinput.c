// rawinput.c
//
// Minimal Raw Input reader for the KeyCast mouse movement indicator.
//
// Games that lock the pointer read mouse motion from the Raw Input stream and
// pin the OS cursor in place, so a cursor hook sees almost nothing. This module
// reads the same stream the games do: a hidden message window registers for
// mouse raw input with RIDEV_INPUTSINK and receives WM_INPUT for every physical
// mouse report, regardless of which window has focus or where the cursor is.
//
// PRIVACY MODEL:
// Only relative motion is read. A raw input mouse packet carries the movement
// counts the device reported (lLastX/lLastY); this module sums them into two
// integers that the JavaScript side reads and resets on a short timer. Packets
// flagged MOUSE_MOVE_ABSOLUTE (pen tablets, some remote desktops) are ignored
// entirely rather than converted, so no absolute position of any kind is ever
// read, kept, or exposed. Button and wheel data in the packets is not read.
// There is no buffer, no history, and no callback carrying per-event data.

#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <node_api.h>

static HANDLE g_thread = NULL;
static DWORD g_threadId = 0;
static HWND g_hwnd = NULL;
static HANDLE g_ready = NULL;
static volatile LONG g_ok = 0;
static volatile LONG g_dx = 0;
static volatile LONG g_dy = 0;

static const wchar_t CLASS_NAME[] = L"KeyCastRawInput";

static LRESULT CALLBACK WndProc(HWND hwnd, UINT msg, WPARAM wParam, LPARAM lParam) {
  switch (msg) {
    case WM_INPUT: {
      // RAWINPUT is fixed-size for mouse data; the buffer is padded anyway so a
      // surprise never overflows it.
      BYTE buffer[sizeof(RAWINPUT) + 64];
      UINT size = sizeof(buffer);
      if (GetRawInputData((HRAWINPUT)lParam, RID_INPUT, buffer, &size,
                          sizeof(RAWINPUTHEADER)) != (UINT)-1) {
        RAWINPUT* raw = (RAWINPUT*)buffer;
        if (raw->header.dwType == RIM_TYPEMOUSE &&
            !(raw->data.mouse.usFlags & MOUSE_MOVE_ABSOLUTE)) {
          // Relative counts only. Summed and read atomically; never stored
          // beyond the running totals.
          if (raw->data.mouse.lLastX != 0) {
            InterlockedExchangeAdd(&g_dx, raw->data.mouse.lLastX);
          }
          if (raw->data.mouse.lLastY != 0) {
            InterlockedExchangeAdd(&g_dy, raw->data.mouse.lLastY);
          }
        }
      }
      // Raw input requires the message to reach DefWindowProc for cleanup.
      return DefWindowProcW(hwnd, msg, wParam, lParam);
    }
    case WM_CLOSE:
      DestroyWindow(hwnd);
      return 0;
    case WM_DESTROY:
      PostQuitMessage(0);
      return 0;
  }
  return DefWindowProcW(hwnd, msg, wParam, lParam);
}

static DWORD WINAPI ThreadProc(LPVOID param) {
  (void)param;
  HINSTANCE inst = GetModuleHandleW(NULL);

  WNDCLASSEXW wc;
  ZeroMemory(&wc, sizeof(wc));
  wc.cbSize = sizeof(wc);
  wc.lpfnWndProc = WndProc;
  wc.hInstance = inst;
  wc.lpszClassName = CLASS_NAME;
  if (!RegisterClassExW(&wc) && GetLastError() != ERROR_CLASS_ALREADY_EXISTS) {
    InterlockedExchange(&g_ok, 0);
    SetEvent(g_ready);
    return 0;
  }

  // A message-only window: never visible, receives no paint or focus, exists
  // purely to be the raw input target.
  HWND hwnd = CreateWindowExW(0, CLASS_NAME, L"", 0, 0, 0, 0, 0, HWND_MESSAGE,
                              NULL, inst, NULL);
  if (!hwnd) {
    InterlockedExchange(&g_ok, 0);
    SetEvent(g_ready);
    return 0;
  }

  RAWINPUTDEVICE rid;
  rid.usUsagePage = 0x01;  // generic desktop
  rid.usUsage = 0x02;      // mouse
  rid.dwFlags = RIDEV_INPUTSINK;
  rid.hwndTarget = hwnd;
  if (!RegisterRawInputDevices(&rid, 1, sizeof(rid))) {
    DestroyWindow(hwnd);
    InterlockedExchange(&g_ok, 0);
    SetEvent(g_ready);
    return 0;
  }

  g_hwnd = hwnd;
  InterlockedExchange(&g_ok, 1);
  SetEvent(g_ready);

  MSG msg;
  while (GetMessageW(&msg, NULL, 0, 0) > 0) {
    TranslateMessage(&msg);
    DispatchMessageW(&msg);
  }

  // Unregister the sink so no further input is delivered anywhere.
  rid.dwFlags = RIDEV_REMOVE;
  rid.hwndTarget = NULL;
  RegisterRawInputDevices(&rid, 1, sizeof(rid));
  g_hwnd = NULL;
  return 0;
}

// start(): begin capture. Returns true when the raw input sink is live.
static napi_value Start(napi_env env, napi_callback_info info) {
  (void)info;
  napi_value result;
  if (g_thread != NULL) {
    napi_get_boolean(env, TRUE, &result);
    return result;
  }

  InterlockedExchange(&g_dx, 0);
  InterlockedExchange(&g_dy, 0);
  g_ready = CreateEventW(NULL, TRUE, FALSE, NULL);
  g_thread = CreateThread(NULL, 0, ThreadProc, NULL, 0, &g_threadId);
  BOOL ok = FALSE;
  if (g_thread != NULL && WaitForSingleObject(g_ready, 3000) == WAIT_OBJECT_0) {
    ok = (InterlockedCompareExchange(&g_ok, 0, 0) == 1);
  }
  CloseHandle(g_ready);
  g_ready = NULL;
  if (!ok && g_thread != NULL) {
    WaitForSingleObject(g_thread, 1000);
    CloseHandle(g_thread);
    g_thread = NULL;
  }
  napi_get_boolean(env, ok, &result);
  return result;
}

// stop(): end capture and drop any accumulated motion.
static napi_value Stop(napi_env env, napi_callback_info info) {
  (void)info;
  if (g_thread != NULL) {
    if (g_hwnd != NULL) {
      PostMessageW(g_hwnd, WM_CLOSE, 0, 0);
    } else {
      PostThreadMessageW(g_threadId, WM_QUIT, 0, 0);
    }
    // Bounded wait so a wedged thread cannot hang application quit.
    WaitForSingleObject(g_thread, 2000);
    CloseHandle(g_thread);
    g_thread = NULL;
  }
  InterlockedExchange(&g_dx, 0);
  InterlockedExchange(&g_dy, 0);
  napi_value undef;
  napi_get_undefined(env, &undef);
  return undef;
}

// getDelta(): read and reset the accumulated relative motion.
static napi_value GetDelta(napi_env env, napi_callback_info info) {
  (void)info;
  LONG dx = InterlockedExchange(&g_dx, 0);
  LONG dy = InterlockedExchange(&g_dy, 0);
  napi_value obj, vx, vy;
  napi_create_object(env, &obj);
  napi_create_int32(env, (int32_t)dx, &vx);
  napi_create_int32(env, (int32_t)dy, &vy);
  napi_set_named_property(env, obj, "dx", vx);
  napi_set_named_property(env, obj, "dy", vy);
  return obj;
}

static napi_value Init(napi_env env, napi_value exports) {
  napi_value fn;
  napi_create_function(env, "start", NAPI_AUTO_LENGTH, Start, NULL, &fn);
  napi_set_named_property(env, exports, "start", fn);
  napi_create_function(env, "stop", NAPI_AUTO_LENGTH, Stop, NULL, &fn);
  napi_set_named_property(env, exports, "stop", fn);
  napi_create_function(env, "getDelta", NAPI_AUTO_LENGTH, GetDelta, NULL, &fn);
  napi_set_named_property(env, exports, "getDelta", fn);
  return exports;
}

NAPI_MODULE(NODE_GYP_MODULE_NAME, Init)
