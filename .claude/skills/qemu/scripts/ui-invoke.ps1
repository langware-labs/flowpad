# Press a button in a native window of the guest by its NAME (Windows UI Automation) — for UI
# no web/CDP client can reach: a browser's own prompts ("This site is trying to open …"), a
# system dialog. Runs in the USER lane (the interactive desktop).
#
#   (echo '$Button="Open"; $Window="*Edge*"'; cat scripts/ui-invoke.ps1) | scripts/vmrun.py -t 240 -
#
# $Window is a -like pattern on the top-level window title — name it: every matching window is
# searched to its leaves, and '*' walks the whole desktop. Prints the texts beside the button,
# then "invoked <Button>", or "no <Button> button" — read that before assuming.
if (-not $Button) { $Button = 'OK' }
if (-not $Window) { $Window = '*' }
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
$ae = [System.Windows.Automation.AutomationElement]
$scope = [System.Windows.Automation.TreeScope]
$type = [System.Windows.Automation.ControlType]
# Anything with that name that can be pressed — a classic dialog exposes its buttons as panes.
$isButton = New-Object System.Windows.Automation.AndCondition(
  (New-Object System.Windows.Automation.PropertyCondition($ae::NameProperty, $Button)),
  (New-Object System.Windows.Automation.PropertyCondition($ae::IsInvokePatternAvailableProperty, $true)))
$isText = New-Object System.Windows.Automation.PropertyCondition($ae::ControlTypeProperty, $type::Text)
foreach ($w in $ae::RootElement.FindAll($scope::Children, [System.Windows.Automation.Condition]::TrueCondition)) {
  if ($w.Current.Name -notlike $Window) { continue }
  $b = $w.FindFirst($scope::Descendants, $isButton)
  if (-not $b) { continue }
  Write-Output ("window: " + $w.Current.Name)
  # The dialog's own texts sit beside the button — not the whole window's (a browser's page).
  $dialog = [System.Windows.Automation.TreeWalker]::ControlViewWalker.GetParent($b)
  $dialog.FindAll($scope::Descendants, $isText) | Select-Object -First 6 | ForEach-Object { Write-Output ("text: " + $_.Current.Name) }
  $b.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke()
  Write-Output ("invoked " + $Button)
  return
}
Write-Output ("no " + $Button + " button")
