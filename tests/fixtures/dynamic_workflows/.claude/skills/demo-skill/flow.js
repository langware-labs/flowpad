export const meta = {
  name: 'demo-skill-flow',
  description: 'A workflow bundled inside a skill',
  phases: [{ title: 'Main', detail: 'one agent' }],
}

phase('Main')
const r = await agent('Do the thing.')
return { r }
