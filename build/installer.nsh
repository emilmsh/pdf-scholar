; Custom NSIS steps (electron-builder's nsis.include).
;
; The app registers itself as the browser extension's native-messaging host at
; every start (src/main/native-host-register.ts): one HKCU key per browser.
; Take them back on a real uninstall — not on an update, which runs the old
; uninstaller first and is followed by an app start that writes them again.
!macro customUnInstall
  ${ifNot} ${isUpdated}
    DeleteRegKey HKCU "Software\Google\Chrome\NativeMessagingHosts\no.emil.pdfscholar"
    DeleteRegKey HKCU "Software\Microsoft\Edge\NativeMessagingHosts\no.emil.pdfscholar"
  ${endIf}
!macroend
