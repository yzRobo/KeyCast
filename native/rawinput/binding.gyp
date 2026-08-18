{
  "targets": [
    {
      "target_name": "rawinput",
      "sources": ["rawinput.c"],
      "conditions": [
        ["OS=='win'", {
          "libraries": ["user32.lib"]
        }]
      ]
    }
  ]
}
