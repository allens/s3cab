# Runs `claude` with the arguments given, its output into the log, for cleanroom.yml's
# Windows sessions, where no shell sandbox walls the session off: the session starts in a
# new login's environment instead of the job's, so none of the job's variables reach it
# (the OIDC request pair, GITHUB_*). Copied out of the checkout before the checkout is
# deleted.
#
# The registry's Machine and User scopes are what Windows writes into a new login; the
# names below it computes per login, so they come from the job. TEMP and TMP too: the
# job's are the 8.3 spelling (C:\Users\RUNNER~1\...) the audit's tmpdir() reads, the
# registry's the long one, so a session given those would have its own scratchpad flagged.
# PATH too, for setup-node's node and the claude installed beside it.
param(
  [Parameter(Mandatory)] [string] $Log,
  [Parameter(Mandatory, ValueFromRemainingArguments)] [string[]] $Arguments
)

$login = @{}
foreach ($scope in 'Machine', 'User') {
  $vars = [Environment]::GetEnvironmentVariables($scope)
  foreach ($name in $vars.Keys) { $login[$name] = $vars[$name] }
}
$fromJob = 'SystemRoot', 'SystemDrive', 'ProgramFiles', 'ProgramFiles(x86)', 'ProgramW6432',
  'CommonProgramFiles', 'CommonProgramFiles(x86)', 'CommonProgramW6432', 'ProgramData',
  'ALLUSERSPROFILE', 'PUBLIC', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'APPDATA',
  'LOCALAPPDATA', 'USERNAME', 'USERDOMAIN', 'COMPUTERNAME', 'TEMP', 'TMP', 'Path',
  'CLAUDE_CODE_OAUTH_TOKEN'
foreach ($name in $fromJob) {
  $value = [Environment]::GetEnvironmentVariable($name)
  if ($null -ne $value) { $login[$name] = $value }
}

# Through env:, not [Environment]::SetEnvironmentVariable($name, $null): pwsh 7.6 still
# hands a child the variable that removes, set and empty.
Get-ChildItem env: | ForEach-Object { Remove-Item -LiteralPath "env:$($_.Name)" }
foreach ($name in $login.Keys) {
  Set-Item -LiteralPath "env:$name" -Value $login[$name]
}

claude @Arguments *> $Log
exit $LASTEXITCODE
