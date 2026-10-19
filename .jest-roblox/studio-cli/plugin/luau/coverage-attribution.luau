--!strict
-- Per-test coverage attribution: pure snapshot-and-diff over the runtime hit
-- table (`_G.__jest_roblox_cov`). The runner snapshots before each Jest test
-- case and diffs after, attributing the newly-covered statements to that test.
--
-- Coverage-primitive-agnostic: the input is whatever accumulated hit table the
-- collector exposes (Lute probes today, native ScriptContext stats later), so
-- the diff is identical regardless of how the counts were produced.

-- `s` is the per-statement hit-count map, keyed by statement id. The single
-- letter is the wire key the coverage probes emit (`__cov_s`, serialized as `s`
-- under `_G.__jest_roblox_cov[file]`), matching `RawFileCoverage` on the
-- TypeScript side.
type FileHitCounts = { s: { number } }
type HitTableByFile = { [string]: FileHitCounts }

-- A test's delta: the ids of the statements it newly covered, per file. `s`
-- again mirrors the serialized envelope the TypeScript parser validates.
type FileStatementDelta = { s: { number } }
type CoverageDeltaByFile = { [string]: FileStatementDelta }

local module = {}

-- Copy the statement hit counts so a later mutation of the live table does not
-- alias the snapshot. Probes only ever increment, so the copied counts are the
-- pre-test baseline the diff subtracts against.
function module.snapshot(coverage: HitTableByFile): HitTableByFile
	local baseline: HitTableByFile = {}
	for fileKey, fileHitCounts in coverage do
		local statementCounts: { number } = {}
		for statementId, hitCount in fileHitCounts.s do
			statementCounts[statementId] = hitCount
		end

		baseline[fileKey] = { s = statementCounts }
	end

	return baseline
end

-- Statements whose count rose between `before` and `after` were executed during
-- the test, so they are attributed to it. Files with no newly-covered statement
-- are omitted.
function module.diff(before: HitTableByFile, after: HitTableByFile): CoverageDeltaByFile
	local delta: CoverageDeltaByFile = {}
	for fileKey, afterCounts in after do
		local beforeCounts = before[fileKey]
		local coveredStatementIds: { number } = {}

		for statementId, afterHitCount in afterCounts.s do
			local beforeHitCount = if beforeCounts then beforeCounts.s[statementId] or 0 else 0
			if afterHitCount > beforeHitCount then
				table.insert(coveredStatementIds, statementId)
			end
		end

		if #coveredStatementIds > 0 then
			delta[fileKey] = { s = coveredStatementIds }
		end
	end

	return delta
end

return module
