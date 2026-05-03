import { DockPointer } from './DockPointer';

export interface ConversationRouteContext {
  conversationId: string;
  taskId?: string | null;
  projectId?: string | null;
}

type Resolver = (ctx: ConversationRouteContext) => DockPointer | null;

const ROUTE_PRIORITY: Resolver[] = [
  (ctx) =>
    ctx.taskId
      ? DockPointer.forTasks(ctx.taskId, { conversationId: ctx.conversationId })
      : null,
  (ctx) =>
    ctx.projectId
      ? DockPointer.forProject(ctx.projectId, { conversationId: ctx.conversationId })
      : null,
  (ctx) => DockPointer.forConversation(ctx.conversationId),
];

export function resolveConversationDockPointer(ctx: ConversationRouteContext): DockPointer {
  for (const resolver of ROUTE_PRIORITY) {
    const ptr = resolver(ctx);
    if (ptr) return ptr;
  }
  return DockPointer.forConversation(ctx.conversationId);
}
