export const meta = {
  name: 'sample-flow',
  description: 'A tiny sample dynamic workflow for tests',
  phases: [{ title: 'Main', detail: 'one agent' }],
}

phase('Main')
const result = await agent('Do the thing.')
return { result }
