export * from './cli_workers';
export * from './claude_hook_events';
export * from './agent_hooks/index';
export * from './process/index';
export * from './alert';
export * from './APIEntity';
export { PERF_T0_KEY, markPerfT0, perfLog, perfTime } from './utils/perf';
export * from './ApiResponse';
export * from './apiStats';
export * from './apps/index';
export * from './capabilities';
export * from './client';
export * from './config';
export * from './constants/system-projects';
export * from './entities/index';
export * from './flow_processing/index';
export * from './FlowSync/index';
export * from './main';
export * from './IEntity';
export * from './IResource';
export * from './main';
export * from './models/index';
export * from './resource_management/index';
export * from './services/index';
export * from './preferences/prefRegistry';
export * from './preferences/indexingConsent';
export * from './stores/fsStore';
export * from './tags/EventBus';
export * from './tags/grammar';
export * from './tags/ws-bridge';
export * from './tabs/index';
export * from './stores/ontology-store';
export * from './icons';
// NOT `export * from './react/FlowIcon'` — the barrel is imported by non-React
// consumers, and re-exporting the component drags React into every one of them.
// `icons/index.ts` advertises itself as framework-free; that has to stay true.
// Import the component from '@sdk/react/FlowIcon', as the react hooks already
// are.
export * from './stores/project-cleanup-store';
export * from './utils';
export * from './websocket';
export * from './worldview';
export * from './types/index';
export * from './schema/index';
// Three names are defined twice under this barrel, so a bare `export *` drops
// all of them (both the type and, for `Skill`/`WorkerType`, the runtime value).
// Name the winner explicitly; the losers stay reachable via their own module.
//   - `Skill`      — the entity class, not the `models/skill` plain-data shape
//                    (internal to SkillManager).
//   - `ShellResult`— `Shell.run`'s result, not the `shell-output` FlowData
//                    payload (whose `exitCode` is optional).
//   - `WorkerType` — the `AgentConfig` enum, the only one of the two that is a
//                    runtime value; the vendor union lives in `process/index`.
export { Skill } from './entities/skill';
export type { ShellResult } from './entities/shell';
export { WorkerType } from './entities/subagent';
export { FSEntry } from './fs/FSEntry';
export { FSRef, type FSRefJson } from './fs/FSRef';
export { FrontMatterFsRef } from './fs/FrontMatterFsRef';
export { Frontmatter } from './fs/Frontmatter';
