@echo off
rem Sincronizador Verifco - atalho para Windows.
rem Confere o Node.js (22 ou mais novo), instala as dependencias na primeira execucao e roda a
rem linha de comando (src\cli.ts) com o Node deste computador.
rem Uso: verifco-sync <comando> [opcoes]     (ex.: verifco-sync configurar)
rem As mensagens daqui vao sem acentos de proposito: um .cmd depende da pagina de codigo do console.
rem Sem "goto" nem rotulos, para o arquivo funcionar tambem se as quebras de linha forem convertidas.
setlocal
set "VERIFCO_DIR=%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js nao encontrado. Instale o Node.js 22 ou mais novo em https://nodejs.org e abra o Prompt de Comando de novo.
  exit /b 1
)
node -e "process.exit(Number(process.versions.node.split('.')[0])>=22?0:1)"
if errorlevel 1 (
  echo O sincronizador precisa do Node.js 22 ou mais novo. Atualize em https://nodejs.org
  exit /b 1
)
if not exist "%VERIFCO_DIR%node_modules\tsx\dist\cli.mjs" (
  echo Instalando as dependencias do sincronizador - so na primeira execucao...
  pushd "%VERIFCO_DIR%"
  call npm install --omit=dev --no-audit --no-fund
  popd
)
if not exist "%VERIFCO_DIR%node_modules\tsx\dist\cli.mjs" (
  echo Nao foi possivel instalar as dependencias. Confira a internet e rode "npm install --omit=dev" na pasta do sincronizador.
  exit /b 1
)
node "%VERIFCO_DIR%node_modules\tsx\dist\cli.mjs" "%VERIFCO_DIR%src\cli.ts" %*
exit /b %ERRORLEVEL%
