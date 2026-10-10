local HttpService = game:GetService("HttpService")
local StudioTestService = game:GetService("StudioTestService")
local payload = HttpService:JSONDecode([=[{"pluginKey":"0.4.5-11eb784c","protocolVersion":9,"test":true,"config":{"configs":[{"testMatch":["**/*.spec","**/*.test"],"passWithNoTests":false,"silent":false,"testPathIgnorePatterns":["/node_modules/","/dist/","/out/"],"verbose":false,"outDir":"./out","injectGlobals":true,"projects":["ServerScriptService/TS","ReplicatedStorage/TS","StarterPlayer/StarterPlayerScripts/TS"],"snapshotFormat":{"printBasicPrototype":false},"jestPath":"ReplicatedStorage/rbxts_include/node_modules/@rbxts-js/Jest","runnerTimeoutMs":60000,"reporters":[]}]},"runtimeStubMounts":[["ServerScriptService/TS","ReplicatedStorage/TS","StarterPlayer/StarterPlayerScripts/TS"]]}]=])
local URL = "ws://localhost:53393"
local REQUEST_ID = [=[93b26067-0604-4c6d-a99c-343d2b611445]=]
local startedOpened, startedSocket = pcall(function()
	return HttpService:CreateWebStreamClient(Enum.WebStreamClientType.WebSocket, { Url = URL })
end)
if startedOpened then
	startedSocket.Opened:Once(function()
		startedSocket:Send(HttpService:JSONEncode({ type = "started", requestId = REQUEST_ID }))
	end)
	startedSocket.Error:Once(function(_statusCode, errorMessage)
		print("studio-cli: start socket error: " .. tostring(errorMessage))
	end)
else
	print("studio-cli: failed to open start socket: " .. tostring(startedSocket))
end
local ok, result = pcall(function()
	return StudioTestService:ExecuteRunModeAsync(payload)
end)
local message
if not ok then
	message = { type = "results", requestId = REQUEST_ID, gameOutput = "[]", jestOutput = HttpService:JSONEncode({ err = tostring(result), success = false }) }
elseif typeof(result) ~= "table" or result.jestOutput == nil then
	message = { type = "results", requestId = REQUEST_ID, gameOutput = "[]", jestOutput = HttpService:JSONEncode({ err = "studio-cli: the jest plugin produced no result. Install or update the jest-roblox Studio plugin.", success = false }) }
else
	message = { type = "results", requestId = REQUEST_ID, protocolVersion = result.protocolVersion, pluginVersion = result.pluginVersion, gameOutput = result.gameOutput or "[]", jestOutput = result.jestOutput }
end
local encoded = HttpService:JSONEncode(message)
local connected, socket = pcall(function()
	return HttpService:CreateWebStreamClient(Enum.WebStreamClientType.WebSocket, { Url = URL })
end)
if not connected then
	print("studio-cli: failed to open result socket: " .. tostring(socket))
	return
end
local finished = false
socket.Opened:Once(function()
	socket:Send(encoded)
end)
socket.Error:Once(function(_statusCode, errorMessage)
	print("studio-cli: result socket error: " .. tostring(errorMessage))
	finished = true
end)
socket.Closed:Once(function()
	finished = true
end)
local start = os.clock()
while not finished and os.clock() - start < 30 do
	task.wait(0.05)
end
