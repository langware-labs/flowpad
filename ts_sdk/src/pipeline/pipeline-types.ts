/**
 * Pipeline types for flow-cli.
 *
 * A Pipeline is a directed graph of agentic tasks with typed inputs/outputs
 * on edges, supporting splits, conditions, and parallel branches.
 *
 * Format: n8n-inspired nodes+edges arrays with CWL-style typed ports.
 */

export type PipelineNodeType = 'task' | 'switch' | 'fork' | 'input' | 'start' | 'end'

export interface PipelinePort {
  type: string
}

export interface SwitchCase {
  when?: string
  default?: boolean
  then: string
}

export interface Position {
  x: number
  y: number
}

export interface PipelineNode {
  id: string
  type: PipelineNodeType
  label: string
  description?: string
  inputs: Record<string, PipelinePort>
  outputs: Record<string, PipelinePort>
  /** For switch nodes: ordered list of cases */
  cases?: SwitchCase[]
  /** For fork nodes: named output branches */
  branches?: string[]
  /** For fork nodes: join strategy ("all" | "first") */
  join?: 'all' | 'first'
  config?: Record<string, unknown>
  position?: Position
}

export interface PipelineEdge {
  id: string
  from_node: string
  from_port: string
  to_node: string
  to_port: string
  record_type?: string
  label?: string
}

export interface RecordTypeSchema {
  fields: Record<string, string>
}

export interface Pipeline {
  id: string
  version: string
  description?: string
  nodes: PipelineNode[]
  edges: PipelineEdge[]
  record_types?: Record<string, RecordTypeSchema>
}
