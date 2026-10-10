!macro EditLongOpenWithExt ext
  WriteRegStr SHCTX "Software\Classes\.${ext}\OpenWithProgids" "EditLong.Document" ""
  WriteRegStr SHCTX "Software\Classes\.${ext}\OpenWithList\EditLong.exe" "" ""
  WriteRegStr SHCTX "Software\Classes\Applications\EditLong.exe\SupportedTypes" ".${ext}" ""
!macroend

!macro EditLongUnOpenWithExt ext
  DeleteRegValue SHCTX "Software\Classes\.${ext}\OpenWithProgids" "EditLong.Document"
  DeleteRegKey SHCTX "Software\Classes\.${ext}\OpenWithList\EditLong.exe"
!macroend

!macro customInstall
  ; 右键菜单
  WriteRegStr SHCTX "Software\Classes\*\shell\EditLongOpen" "" "用 EditLong 打开"
  WriteRegStr SHCTX "Software\Classes\*\shell\EditLongOpen" "Icon" "$INSTDIR\EditLong.exe"
  WriteRegStr SHCTX "Software\Classes\*\shell\EditLongOpen\command" "" '"$INSTDIR\EditLong.exe" "%1"'

  ; 打开方式（ProgID）
  WriteRegStr SHCTX "Software\Classes\EditLong.Document" "" "EditLong 文档"
  WriteRegStr SHCTX "Software\Classes\EditLong.Document\DefaultIcon" "" "$INSTDIR\EditLong.exe,0"
  WriteRegStr SHCTX "Software\Classes\EditLong.Document\shell\open\command" "" '"$INSTDIR\EditLong.exe" "%1"'

  ; 打开方式（Applications）
  WriteRegStr SHCTX "Software\Classes\Applications\EditLong.exe" "FriendlyAppName" "EditLong"
  WriteRegStr SHCTX "Software\Classes\Applications\EditLong.exe\DefaultIcon" "" "$INSTDIR\EditLong.exe,0"
  WriteRegStr SHCTX "Software\Classes\Applications\EditLong.exe\shell\open\command" "" '"$INSTDIR\EditLong.exe" "%1"'
  WriteRegStr SHCTX "Software\Classes\Applications\EditLong.exe\SupportedTypes" ".*" ""

  ; 任意文件的「打开方式」列表
  WriteRegStr SHCTX "Software\Classes\*\OpenWithList\EditLong.exe" "" ""
  WriteRegStr SHCTX "Software\Classes\*\OpenWithProgids" "EditLong.Document" ""

  ; App Paths
  WriteRegStr SHCTX "Software\Microsoft\Windows\CurrentVersion\App Paths\EditLong.exe" "" "$INSTDIR\EditLong.exe"
  WriteRegStr SHCTX "Software\Microsoft\Windows\CurrentVersion\App Paths\EditLong.exe" "Path" "$INSTDIR"

  !insertmacro EditLongOpenWithExt "txt"
  !insertmacro EditLongOpenWithExt "log"
  !insertmacro EditLongOpenWithExt "md"
  !insertmacro EditLongOpenWithExt "json"
  !insertmacro EditLongOpenWithExt "xml"
  !insertmacro EditLongOpenWithExt "csv"
  !insertmacro EditLongOpenWithExt "ini"
  !insertmacro EditLongOpenWithExt "cfg"
  !insertmacro EditLongOpenWithExt "conf"
  !insertmacro EditLongOpenWithExt "js"
  !insertmacro EditLongOpenWithExt "ts"
  !insertmacro EditLongOpenWithExt "css"
  !insertmacro EditLongOpenWithExt "html"
  !insertmacro EditLongOpenWithExt "htm"
  !insertmacro EditLongOpenWithExt "py"
  !insertmacro EditLongOpenWithExt "c"
  !insertmacro EditLongOpenWithExt "cpp"
  !insertmacro EditLongOpenWithExt "h"
  !insertmacro EditLongOpenWithExt "java"
  !insertmacro EditLongOpenWithExt "sql"
  !insertmacro EditLongOpenWithExt "bat"
  !insertmacro EditLongOpenWithExt "cmd"
  !insertmacro EditLongOpenWithExt "yml"
  !insertmacro EditLongOpenWithExt "yaml"
  !insertmacro EditLongOpenWithExt "bin"
  !insertmacro EditLongOpenWithExt "dat"
  !insertmacro EditLongOpenWithExt "hex"
!macroend

!macro customUnInstall
  DeleteRegKey SHCTX "Software\Classes\*\shell\EditLongOpen"
  DeleteRegKey SHCTX "Software\Classes\EditLong.Document"
  DeleteRegKey SHCTX "Software\Classes\Applications\EditLong.exe"
  DeleteRegKey SHCTX "Software\Classes\*\OpenWithList\EditLong.exe"
  DeleteRegValue SHCTX "Software\Classes\*\OpenWithProgids" "EditLong.Document"
  DeleteRegKey SHCTX "Software\Microsoft\Windows\CurrentVersion\App Paths\EditLong.exe"

  !insertmacro EditLongUnOpenWithExt "txt"
  !insertmacro EditLongUnOpenWithExt "log"
  !insertmacro EditLongUnOpenWithExt "md"
  !insertmacro EditLongUnOpenWithExt "json"
  !insertmacro EditLongUnOpenWithExt "xml"
  !insertmacro EditLongUnOpenWithExt "csv"
  !insertmacro EditLongUnOpenWithExt "ini"
  !insertmacro EditLongUnOpenWithExt "cfg"
  !insertmacro EditLongUnOpenWithExt "conf"
  !insertmacro EditLongUnOpenWithExt "js"
  !insertmacro EditLongUnOpenWithExt "ts"
  !insertmacro EditLongUnOpenWithExt "css"
  !insertmacro EditLongUnOpenWithExt "html"
  !insertmacro EditLongUnOpenWithExt "htm"
  !insertmacro EditLongUnOpenWithExt "py"
  !insertmacro EditLongUnOpenWithExt "c"
  !insertmacro EditLongUnOpenWithExt "cpp"
  !insertmacro EditLongUnOpenWithExt "h"
  !insertmacro EditLongUnOpenWithExt "java"
  !insertmacro EditLongUnOpenWithExt "sql"
  !insertmacro EditLongUnOpenWithExt "bat"
  !insertmacro EditLongUnOpenWithExt "cmd"
  !insertmacro EditLongUnOpenWithExt "yml"
  !insertmacro EditLongUnOpenWithExt "yaml"
  !insertmacro EditLongUnOpenWithExt "bin"
  !insertmacro EditLongUnOpenWithExt "dat"
  !insertmacro EditLongUnOpenWithExt "hex"
!macroend
