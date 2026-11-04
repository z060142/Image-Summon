; Image Summon — extra NSIS steps (included by electron-builder)
; Registers the app to start with Windows (minimised to tray) and cleans up on uninstall.

!macro customInstall
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "ImageSummon" '"$INSTDIR\ImageSummon.exe" --hidden'
!macroend

!macro customUnInstall
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "ImageSummon"
  ; stop a running instance so files can be removed
  nsExec::Exec 'taskkill /IM ImageSummon.exe /F'
!macroend
