import {
  Bot,
  BookOpen,
  Brain,
  CheckSquare,
  ExternalLink,
  FileCheck2,
  FileText,
  FolderOpen,
  MessageSquare,
  Palette,
  Shield,
  Sparkles,
  Terminal,
  User,
  Users,
  Workflow,
  type LucideIcon,
} from 'lucide-react';
import { lucideByName } from './lucideByName';

const FALLBACK: Record<string, LucideIcon> = {
  project: FolderOpen,
  task: CheckSquare,
  conversation: MessageSquare,
  spec: FileCheck2,
  user: User,
  skill: Sparkles,
  markdown: FileText,
  agent: Bot,
  whiteboard: Palette,
  workflow: Workflow,
  claude_memory: Brain,
  claude_rules: Shield,
  claude_md: BookOpen,
  shell: Terminal,
  workspace: Users,
  agentic_process: Workflow,
};

let registry: Record<string, LucideIcon> = { ...FALLBACK };
let initialized = false;
let initPromise: Promise<void> | null = null;

async function fetchSchemaIcons(): Promise<Record<string, string>> {
  try {
    const res = await fetch('/api/v1/agent/schema');
    if (!res.ok) return {};
    const data = await res.json();
    const out: Record<string, string> = {};
    for (const t of data.types ?? []) {
      if (t.type_name && t.icon) out[t.type_name] = t.icon;
    }
    return out;
  } catch {
    return {};
  }
}

export async function initIconRegistry(): Promise<void> {
  if (initialized) return;
  if (initPromise) return initPromise;
  initPromise = (async () => {
    const schemaIcons = await fetchSchemaIcons();
    const merged = { ...FALLBACK };
    for (const [type, iconName] of Object.entries(schemaIcons)) {
      merged[type] = lucideByName(iconName);
    }
    registry = merged;
    initialized = true;
  })();
  return initPromise;
}

export function iconForType(type: string): LucideIcon {
  return registry[type] ?? ExternalLink;
}

export function allTypes(): string[] {
  return Object.keys(registry).sort();
}
