<#
	Refuses to start the jest-roblox suite while a Studio is open, because starting it would close that
	Studio.

	**The conflict cannot be fixed, only made visible, and this is why.** Roblox Studio is single-instance:
	launching it while it is already running does not start a second one, it hands the request to the
	instance that is there. The runner launches Studio exactly the way a person does -- `spawnStudio` in
	node_modules/@isentinel/jest-roblox/dist/run-txI6i7Sq.mjs, which spawns
	`RobloxStudioBeta.exe` and declares `windowsHide: !headed` -- so with a Studio already open, the
	runner's launch is delivered to that instance, which opens the runner's place file and closes whatever
	was open instead. There is no flag that changes this and no way for the two to share the app: one
	Studio is all the machine ever has. So nothing here tries to make them coexist. The only honest thing
	a script can do is refuse, say what it found, and leave the decision to whoever is sitting there.

	**Do not "fix" this by waiting for Studio, retrying, or running the CLI anyway.** A run that overlaps a
	session does not fail loudly, it discards work; and for this particular collision the runner's own
	failure output is the misleading "the jest plugin produced no result", which is why this check has to
	run *before* the CLI rather than react to it afterwards.

	**The lock file is how a leftover Studio is told apart from a session somebody is using.** Studio
	creates `<place>.lock` beside the place file it opens and removes it when it exits, so the presence of
	.jest-roblox/studio-cli/place.rbxl.lock means a Studio opened *the runner's own place* -- which no
	interactive session ever does, because that path is the CLI's scratch directory. Held, it means that
	Studio is still alive, and that is the orphan case a later run cannot clear for itself: `spawnStudio`
	deletes a stale lock before spawning (`fs.rmSync(lockFile, { force: true })`), and that delete is
	precisely what fails with EPERM while an orphan still has the file open. Present but *not* held is the
	harmless third case -- the file a hard-killed Studio could not remove -- and the CLI clears that itself,
	so it is reported and then ignored.

	**What it does not claim.** The lock says a Studio belongs to a run, not which process holds it: neither
	PowerShell nor .NET can attribute an open file handle to a PID without extra tooling. It is only a
	reliable discriminator because Studio is single-instance, so there is at most one Studio to attribute it
	to. If two ever appear, the process named first in the output is the likeliest owner and the message
	says the attribution is uncertain.

	**ASCII only, deliberately.** Windows PowerShell 5.1 decodes a .ps1 with no byte-order mark as ANSI, so
	an em dash or a curly quote in this file would arrive on the console as mojibake. The message is the
	whole point of the guard; it is written in characters that cannot be mangled.

	**What this is not.** It does not kill anything, does not offer a bypass, and does not touch the tests,
	the CLI or the vendored runtime. A Studio is somebody's session, so closing one is their decision.

	**When a Studio is open most of the time** -- which is the ordinary state of a machine somebody is
	building on -- this guard means the suite runs when the machine is free and not otherwise. That is
	accepted rather than worked around. The backend with no Studio in it at all is Open Cloud:
	`--backend open-cloud`, which publishes the built place and runs it remotely. It needs an Open Cloud API
	key allowed to publish that place, and the place's own `ROBLOX_PLACE_ID` and `ROBLOX_UNIVERSE_ID` --
	the CLI reads all three from exactly those environment variables, or from equivalent config fields;
	see `resolveCredentials` and `FIELD_SPECS` in
	node_modules/@isentinel/jest-roblox/dist/run-txI6i7Sq.mjs. That is the way to run these tests while
	working, and setting it up is deliberately out of scope here.

	Exit codes: whatever the CLI returns when the suite actually ran (0 for a pass), 2 for the CLI's own
	failure (its code, "the jest plugin produced no result"), and 3 when this guard refused -- not 1, which
	means a failing test, and not 2, which the CLI already uses for something else.
#>

$ErrorActionPreference = "Stop"

# What the CLI looks for, spelled exactly as it does (WINDOWS_STUDIO_EXECUTABLE in its own source), and
# the same string minus the extension because `Get-Process -Name` matches on the name, not the file.
$StudioExecutable = "RobloxStudioBeta.exe"
$StudioProcessName = "RobloxStudioBeta"

# Resolved from this file rather than the current directory, so the guard cannot end up inspecting a lock
# belonging to some other checkout.
$Root = Split-Path -Parent $PSScriptRoot
$LockPath = Join-Path $Root ".jest-roblox\studio-cli\place.rbxl.lock"

# Not 1, which a caller would read as "the tests failed", and not 2, which the CLI uses itself.
$RefusedCode = 3

<#
	Whether anything has `$Path` open. `FileShare.None` is the strictest request there is, so this fails if
	any other process holds the file at all -- which is exactly the question, and the same test the CLI
	makes when its own delete comes back EPERM.

	Anything that is not "the file opened cleanly" is reported as held, including an error that has nothing
	to do with sharing. That direction is deliberate for a guard: a lock it cannot read is a reason to ask
	somebody to look, not a reason to start a run that might close their session.
#>
function Test-LockHeld {
	param([string] $Path)

	try {
		$handle = [System.IO.File]::Open($Path, [System.IO.FileMode]::Open, [System.IO.FileAccess]::ReadWrite, [System.IO.FileShare]::None)
		$handle.Dispose()
		return $false
	} catch {
		return $true
	}
}

<# One line naming a Studio, for the message. A start time can be refused for a process this user cannot
   query, so it is optional rather than fatal.

   **Called positionally, and that is deliberate.** A PowerShell simple function does not reject an
   argument it has no parameter for: `-SomeMisspeltName $process` binds nothing at all, leaves the
   parameter `$null` and raises no error, so the message quietly reads "PID , started start time
   unavailable" -- which is exactly the failure this helper had in its first version, and the reason the
   guard was re-run against a real process rather than trusted after inspection. A positional argument
   cannot miss by name. #>
function Format-Studio {
	param($StudioProcess)

	$started = "start time unavailable"
	try { $started = $StudioProcess.StartTime.ToString("HH:mm:ss") } catch { }

	return "$StudioExecutable (PID $($StudioProcess.Id), started $started)"
}

<# The refusal envelope: what was found, what would happen, what to do. #>
function Write-Refusal {
	param([string[]] $Body)

	Write-Host ""
	Write-Host "[jest-roblox] Refusing to run." -ForegroundColor Yellow
	foreach ($line in $Body) { Write-Host $line }
	Write-Host ""
}

$studios = @(Get-Process -Name $StudioProcessName -ErrorAction SilentlyContinue)
$lockExists = Test-Path -LiteralPath $LockPath
$lockHeld = $lockExists -and (Test-LockHeld -Path $LockPath)

if ($lockHeld) {
	# Two shapes, because the advice differs: a Studio with a PID can be named and closed, and the case
	# where nothing is running under that name has no process to point at -- which is worth saying rather
	# than printing an empty Stop-Process line.
	$found = if ($studios.Count -gt 0) {
		"  Found: $(($studios | ForEach-Object { Format-Studio $_ }) -join "; "), and it is holding:"
	} else {
		"  Found: nothing is running under the name $StudioExecutable, yet this file is held open:"
	}

	$clear = if ($studios.Count -gt 0) {
		@(
			"  To clear it, close that Studio, or:",
			"    Stop-Process -Id $($studios[0].Id) -Force"
		)
	} else {
		@(
			"  To clear it, close whatever has that file open. This script can only name a Studio, and there",
			"  is none under that name, so there is nothing here to point at and nothing to close for you."
		)
	}

	# Joined with `+` rather than nested inside one `@(...)`: an array placed inside another array stays a
	# nested element, and `Write-Host` would print the two advice lines on a single line.
	$body = @(
		$found,
		"    $LockPath",
		"",
		"  That lock is created by the Studio the runner opens, beside the runner's own place file, so the",
		"  Studio it belongs to was started by a previous test run and left behind. It is not a session",
		"  somebody is editing in -- an interactive Studio never opens that path.",
		"",
		"  A run now would not get as far as the tests. The CLI clears a stale lock by deleting that file",
		"  before it spawns Studio, and that delete fails with EPERM while this process holds it open, so the",
		"  run dies before it builds -- which looks like a broken suite rather than a leftover process.",
		""
	) + $clear + @(
		"",
		"  Nothing has been closed for you: shutting down another program is your decision, not this script's."
	)

	Write-Refusal -Body $body

	exit $RefusedCode
}

if ($studios.Count -gt 0) {
	$found = ($studios | ForEach-Object { Format-Studio $_ }) -join "; "

	Write-Refusal -Body @(
		"  Found: $found",
		"  and nothing holds $LockPath,",
		"  so this Studio was not started by a test run. It is your session.",
		"",
		"  Running the suite now would not fail first. Studio is single-instance, so the runner's own launch",
		"  is handed to the instance you already have, which opens the runner's place file and closes",
		"  whatever is open in it instead. Unsaved work in that session goes with it, and the runner cannot",
		"  be asked to share the app -- there is only ever one Studio.",
		"",
		"  To run the suite: save your work, close Studio, and start this again.",
		"  To run it without a Studio at all, `--backend open-cloud` needs no Studio on this machine; the",
		"  header of tools/run-tests.ps1 says what it costs.",
		"",
		"  Nothing has been closed for you: shutting down another program is your decision, not this script's."
	)

	exit $RefusedCode
}

if ($lockExists) {
	# Reached only with no Studio running, so nothing holds the file: the leftover of a Studio that was
	# killed before it could remove its own lock. Harmless, and the CLI deletes it on the way past, so this
	# is a note rather than a refusal -- but it is printed, because deleting it here would be a change to
	# someone else's working directory made silently.
	Write-Host "[jest-roblox] A stale $LockPath is left over from a run that was killed. The CLI deletes it before it spawns Studio, so this is harmless; leaving it alone." -ForegroundColor DarkGray
}

Write-Host "[jest-roblox] No Studio is running. Starting the suite." -ForegroundColor DarkGray

# The CLI resolves jest.config.ts relative to the working directory, so the suite is started from the repo
# root whatever directory this was invoked from. A script run with -File is its own process, so this does
# not move the caller's shell.
Set-Location -LiteralPath $Root

# Anything the caller passed goes through untouched, so `npm run test -- --verbose` still means what it
# says and the guarded run is the same run as before.
$cliArguments = @("jest-roblox", "--backend", "studio-cli", "--headed") + $args
& npx @cliArguments

# The CLI's own code, so a pass stays a pass and a failure stays a failure.
exit $LASTEXITCODE
