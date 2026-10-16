Set WshShell = CreateObject("WScript.Shell")
WshShell.CurrentDirectory = "C:\Users\DFIT\PCTrackerAgent"
WshShell.Run """C:\Program Files\nodejs\node.exe"" ""C:\Users\DFIT\PCTrackerAgent\session1-helper.js""", 0, False
WshShell.Run """C:\Program Files\nodejs\node.exe"" ""C:\Users\DFIT\PCTrackerAgent\agent.js""", 0, False
