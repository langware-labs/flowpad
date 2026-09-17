/**
 * The tiny "course" a shared project carries: one lecture page plus one
 * auto-launch agent asset. It exists so the share journey transports something
 * with the two properties that matter — a file the student must end up holding,
 * and an `agentic-assets/agent/**` asset whose `auto_launch` makes the project
 * open into a session on arrival.
 *
 * `agent.json` IS the AgentSpec (`flow_sdk/schema/data_spec/agent_spec.py`);
 * `name` comes from the folder, and the `id` is adopted only if it is a valid
 * entity id — hence a real uuid v4, so the SAME id is the row on both sides.
 */
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';

export interface SeededCourse {
  /** Agent folder name = the agent's name. */
  agentName: string;
  /** The uuid v4 written into `agent.json` — the id BOTH instances index it at. */
  agentId: string;
  /** The queued first turn, asserted in the browser. */
  prompt: string;
  /** Paths relative to the project mount, asserted on the receiver's disk. */
  lessonRelPath: string;
  agentJsonRelPath: string;
}

/** Write the course into `root` (a git worktree). Caller commits + pushes. */
export function seedCourseProject(root: string, token: string): SeededCourse {
  const agentName = `course-guide-${token}`;
  const agentId = randomUUID();
  const prompt = `Say COURSE READY ${token} and nothing else.`;

  const lessonRelPath = path.join('lectures', 'lesson-01.html');
  mkdirSync(path.join(root, 'lectures'), { recursive: true });
  writeFileSync(
    path.join(root, lessonRelPath),
    `<!doctype html>\n<html lang="en"><head><meta charset="utf-8">\n<title>Lesson 01</title></head>\n<body><h1>Lesson 01</h1><p data-token="${token}">${token}</p></body></html>\n`,
    'utf-8',
  );

  const agentDir = path.join(root, 'agentic-assets', 'agent', agentName);
  mkdirSync(agentDir, { recursive: true });
  const agentJsonRelPath = path.join('agentic-assets', 'agent', agentName, 'agent.json');
  writeFileSync(
    path.join(agentDir, 'agent.json'),
    `${JSON.stringify(
      {
        type: 'agent',
        id: agentId,
        name: agentName,
        title: `Course guide ${token}`,
        description: 'Guides a student through the course lectures.',
        worker_type: 'claude',
        intro: `Hello from ${agentName}. I will walk you through lesson 01.`,
        enabled: true,
        auto_launch: true,
        auto_launch_prompt: prompt,
      },
      null,
      2,
    )}\n`,
    'utf-8',
  );
  writeFileSync(
    path.join(agentDir, 'system_prompt.md'),
    'You guide one student through the course lectures. Answer with hints, never the solution.\n',
    'utf-8',
  );

  return { agentName, agentId, prompt, lessonRelPath, agentJsonRelPath };
}
