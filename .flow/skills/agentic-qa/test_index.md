# Test Index

> Last updated: 2026-09-05T23:48:05.702Z
> Scope: every scenario `.md` and every `.md.ts` under `ui/tests/manual_regression`, including root files and executable-only scenarios. Reserved `_results`, `_shared`, and `_fast_paths` directories are excluded from scenario rows; fast paths are linked.
> Test counts are static TypeScript AST declarations, not execution verdicts; loop-generated tests and project matrices can expand collection. Spec cases count numbered `test N` lines or one document-level scenario when no numbered lines exist.
> `manual: true` is an explicit Phase 12 scope exclusion, never a pass or an approved runtime skip.

Inventory: **142 markdown files**, **166 .md.ts files** (140 paired, 26 executable-only), **1 Phase 12 orphan**, **1 explicit manual scenario**, **2 fast paths**.

Executable declarations: **387** across `.md.ts`; **4** across 2 supplementary `.spec.ts` files listed below.

## (root) (2 scenarios)

| Scenario | Spec cases | Test declarations | Playwright | Fast path | Coverage disposition |
|---|---:|---:|---|---|---|
| `migration.md` | 1 | 2 | yes | no | paired — Phase 11 |
| `run_test_instructions.md` | 1 | 1 | yes | no | paired — Phase 11 |

## agentic-process (17 scenarios)

| Scenario | Spec cases | Test declarations | Playwright | Fast path | Coverage disposition |
|---|---:|---:|---|---|---|
| `agentic-process/agentic_process_visible_restored_on_load.md.ts` | — | 1 | yes | no | executable only — Phase 11 |
| `agentic-process/codex_chat_terminal_full_matrix.md` | 27 | 2 | yes | no | paired — Phase 11 |
| `agentic-process/codex_chat_terminal_switch_matrix.md` | 16 | 2 | yes | no | paired — Phase 11 |
| `agentic-process/conversation_view_three_spawn_branches.md` | 2 | 2 | yes | no | paired — Phase 11 |
| `agentic-process/embedded_close_preserves_process.md` | 1 | 1 | yes | no | paired — Phase 11 |
| `agentic-process/new_claude_session_no_console_errors.md` | 1 | 1 | yes | no | paired — Phase 11 |
| `agentic-process/observability_surfaces.md` | 3 | 3 | yes | no | paired — Phase 11 |
| `agentic-process/open_shell_from_process_workdir.md` | 2 | 2 | yes | no | paired — Phase 11 |
| `agentic-process/opencode_pty_composer_boots.md` | 1 | 1 | yes | no | paired — Phase 11 |
| `agentic-process/process_restart_and_cli_flags.md` | 4 | 4 | yes | no | paired — Phase 11 |
| `agentic-process/process_terminal_shell_tab_navigates_url.md` | 1 | 1 | yes | no | paired — Phase 11 |
| `agentic-process/processtoolbar_fork.md` | 2 | 2 | yes | no | paired — Phase 11 |
| `agentic-process/quick_create_session_browser_url_order.md.ts` | — | 1 | yes | no | executable only — Phase 11 |
| `agentic-process/resume_session_from_recent.md` | 3 | 1 | yes | no | paired — Phase 11 |
| `agentic-process/session_info_popover.md` | 3 | 3 | yes | no | paired — Phase 11 |
| `agentic-process/shell_url_recovers_linked_process.md.ts` | — | 1 | yes | no | executable only — Phase 11 |
| `agentic-process/worktree_lifecycle.md` | 3 | 2 | yes | no | paired — Phase 11 |

## assets (4 scenarios)

| Scenario | Spec cases | Test declarations | Playwright | Fast path | Coverage disposition |
|---|---:|---:|---|---|---|
| `assets/asset_id_collisions.md` | 2 | 2 | yes | no | paired — Phase 11 |
| `assets/assets_list_mode.md` | 6 | 6 | yes | no | paired — Phase 11 |
| `assets/vfs_files_tree_selection.md.ts` | — | 1 | yes | no | executable only — Phase 11 |
| `assets/wiki_folder_tree.md` | 16 | 3 | yes | no | paired — Phase 11 |

## chat (19 scenarios)

| Scenario | Spec cases | Test declarations | Playwright | Fast path | Coverage disposition |
|---|---:|---:|---|---|---|
| `chat/401_unauthorized_when_closing_a_chat.md` | 1 | 1 | yes | no | paired — Phase 11 |
| `chat/chat_input_controls.md` | 2 | 3 | yes | no | paired — Phase 11 |
| `chat/chat_refresh_persistence.md` | 1 | 1 | yes | no | paired — Phase 11 |
| `chat/chat_tab_switching.md` | 1 | 1 | yes | no | paired — Phase 11 |
| `chat/closing_a_chat_produces_console_error_401.md` | 1 | 1 | yes | no | paired — Phase 11 |
| `chat/doc_chat_per_type.md` | 5 | 3 | yes | no | paired — Phase 11 |
| `chat/first_chat_message_is_slow.md` | 1 | 1 | yes | no | paired — Phase 11 |
| `chat/in_chats_expanding_agent_thinking_component_is_not_retained.md` | 1 | 1 | yes | no | paired — Phase 11 |
| `chat/landing_to_new_chat.md` | 1 | 1 | yes | no | paired — Phase 11 |
| `chat/new_session_is_not_opened.md` | 1 | 1 | yes | no | paired — Phase 11 |
| `chat/new_sessions_always_opened_with_session_1_header.md` | 1 | 1 | yes | no | paired — Phase 11 |
| `chat/opening_project_in_explorer_console_error_404.md` | 1 | 1 | yes | no | paired — Phase 11 |
| `chat/prompting_from_app_homepage_does_not_start_new_session.md` | 1 | 1 | yes | no | paired — Phase 11 |
| `chat/prompting_to_start_new_session_from_app_homepage_does_not_wo.md` | 1 | 1 | yes | no | paired — Phase 11 |
| `chat/return_to_home.md` | 1 | 1 | yes | no | paired — Phase 11 |
| `chat/send_multiple_messages.md` | 2 | 2 | yes | no | paired — Phase 11 |
| `chat/sessions_disappear_after_page_refresh.md` | 1 | 1 | yes | no | paired — Phase 11 |
| `chat/switch_between_sessions.md` | 1 | 1 | yes | no | paired — Phase 11 |
| `chat/while_agent_is_executing_refresh_clears_previous_thinking_se.md` | 1 | 1 | yes | no | paired — Phase 11 |

## cli-log (1 scenarios)

| Scenario | Spec cases | Test declarations | Playwright | Fast path | Coverage disposition |
|---|---:|---:|---|---|---|
| `cli-log/cli_log_viewer.md` | 3 | 3 | yes | `_fast_paths/cli-log/cli_log_viewer.fast.ts` | paired — Phase 11 |

## collaboration (9 scenarios)

| Scenario | Spec cases | Test declarations | Playwright | Fast path | Coverage disposition |
|---|---:|---:|---|---|---|
| `collaboration/collaboration_room_add_process.md` | 1 | 1 | yes | no | paired — Phase 11 |
| `collaboration/doc_comment_author_scope.md.ts` | — | 0 | yes | no | executable only — Phase 11 |
| `collaboration/doc_comment_create_sync.md` | 1 | 0 | yes | no | paired — Phase 11 |
| `collaboration/doc_comment_delete_sync.md` | 1 | 0 | yes | no | paired — Phase 11 |
| `collaboration/doc_comment_update_sync.md` | 1 | 0 | yes | no | paired — Phase 11 |
| `collaboration/flowpad_assistant_docs_panel.md` | 3 | 3 | yes | no | paired — Phase 11 |
| `collaboration/project_git_invite_browser.md.ts` | — | 1 | yes | no | executable only — Phase 11 |
| `collaboration/project_room_new_doc.md` | 3 | 3 | yes | no | paired — Phase 11 |
| `collaboration/project_row_opens_collab_space.md` | 3 | 3 | yes | no | paired — Phase 11 |

## conversation (3 scenarios)

| Scenario | Spec cases | Test declarations | Playwright | Fast path | Coverage disposition |
|---|---:|---:|---|---|---|
| `conversation/agent_email_gmail_round_trip.md.ts` | — | 1 | yes | no | executable only — Phase 11 |
| `conversation/conversation_title_rename_live.md` | 1 | 1 | yes | no | paired — Phase 11 |
| `conversation/two_instance_hub_conversation.md` | 1 | 1 | yes | no | paired — Phase 11 |

## data-sources (4 scenarios)

| Scenario | Spec cases | Test declarations | Playwright | Fast path | Coverage disposition |
|---|---:|---:|---|---|---|
| `data-sources/agent_integrations_e2e.md` | 6 | 6 | yes | no | paired — Phase 11 |
| `data-sources/attached_channels.md` | 4 | — | no | no | ORPHAN — Phase 12 required |
| `data-sources/backend_served_sources.md` | 9 | 9 | yes | no | paired — Phase 11 |
| `data-sources/credentialed_sources.md` | 1 | 4 | yes | no | paired — Phase 11 |

## dock-sweep (1 scenarios)

| Scenario | Spec cases | Test declarations | Playwright | Fast path | Coverage disposition |
|---|---:|---:|---|---|---|
| `dock-sweep/dock_sweep.md` | 1 | 2 | yes | no | paired — Phase 11 |

## docs/v0.28_scenarios (3 scenarios)

| Scenario | Spec cases | Test declarations | Playwright | Fast path | Coverage disposition |
|---|---:|---:|---|---|---|
| `docs/v0.28_scenarios/coding_agent_cli.md` | 1 | 1 | yes | no | paired — Phase 11 |
| `docs/v0.28_scenarios/LLM_comfigure.md` | 1 | 1 | yes | no | paired — Phase 11 |
| `docs/v0.28_scenarios/shell_tab.md` | 1 | 1 | yes | no | paired — Phase 11 |

## editor (14 scenarios)

| Scenario | Spec cases | Test declarations | Playwright | Fast path | Coverage disposition |
|---|---:|---:|---|---|---|
| `editor/ami_creating_a_folder_crashes_desktop_app_agent_id_is_missin.md` | 1 | 1 | yes | no | paired — Phase 11 |
| `editor/breadcrumb_fence.md` | 1 | 5 | yes | no | paired — Phase 11 |
| `editor/console_error_404_request_failed_with_status_code_404_when_c.md` | 1 | 1 | yes | no | paired — Phase 11 |
| `editor/console_error_500_failed_to_load_resource_tab_hooks_in_syste.md` | 1 | 1 | yes | no | paired — Phase 11 |
| `editor/editor_download_all_files_console_error.md` | 1 | 1 | yes | no | paired — Phase 11 |
| `editor/editor_tab_download_all_files_fails_to_create_zip.md` | 1 | 1 | yes | no | paired — Phase 11 |
| `editor/editorfiles_tab_creating_a_new_file_doesnt_show_the_file_in.md` | 1 | 1 | yes | no | paired — Phase 11 |
| `editor/execute_flow_error_theme_vs_dark_not_found_you_may_need_to_l.md` | 1 | 1 | yes | no | paired — Phase 11 |
| `editor/files_tab_download_directory_does_nothing.md` | 1 | 1 | yes | no | paired — Phase 11 |
| `editor/files_tab_shows_local_c_as_root_and_doesnt_show_the_temp_wor.md` | 1 | 1 | yes | no | paired — Phase 11 |
| `editor/milkdown_no_wiki_back_button.md` | 1 | 1 | yes | no | paired — Phase 11 |
| `editor/milkdown_selection_toolbar.md` | 6 | 6 | yes | no | paired — Phase 11 |
| `editor/new_prompt_save_indefinitely.md` | 1 | 1 | yes | no | paired — Phase 11 |
| `editor/uploading_a_file_doesnt_show_up_in_the_side_bar.md` | 1 | 1 | yes | no | paired — Phase 11 |

## general (9 scenarios)

| Scenario | Spec cases | Test declarations | Playwright | Fast path | Coverage disposition |
|---|---:|---:|---|---|---|
| `general/app_slow_before_clearing_database.md` | 1 | 1 | yes | no | paired — Phase 11 |
| `general/cloudnsite-install.md.ts` | — | 2 | yes | no | executable only — Phase 11 |
| `general/console_error_482_failed_to_start_in_app_hompage.md` | 1 | 1 | yes | no | paired — Phase 11 |
| `general/current_activity_recent_sessions.md` | 5 | 5 | yes | no | paired — Phase 11 |
| `general/execute_flow_hangs_indefinitely.md` | 1 | 1 | yes | no | paired — Phase 11 |
| `general/heartbeat_sniffer_hook_events_e2e.md` | 2 | 2 | yes | no | paired — Phase 11 |
| `general/mac_desktop_app_hompage_error_500_failed_to_load_system_reso.md` | 1 | 1 | yes | no | paired — Phase 11 |
| `general/refreshing_any_tab_other_than_main_app_error_404_agent_id_mi.md` | 2 | 2 | yes | no | paired — Phase 11 |
| `general/usage_cost_failed_to_fetch_cost_overview.md` | 1 | 1 | yes | no | paired — Phase 11 |

## journey-sweep (1 scenarios)

| Scenario | Spec cases | Test declarations | Playwright | Fast path | Coverage disposition |
|---|---:|---:|---|---|---|
| `journey-sweep/journey_sweep.md.ts` | — | 10 | yes | no | executable only — Phase 11 |

## k_browser (1 scenarios)

| Scenario | Spec cases | Test declarations | Playwright | Fast path | Coverage disposition |
|---|---:|---:|---|---|---|
| `k_browser/atlas_status_and_diff.md` | 1 | 1 | yes | no | paired — Phase 11 |

## markdown_index (1 scenarios)

| Scenario | Spec cases | Test declarations | Playwright | Fast path | Coverage disposition |
|---|---:|---:|---|---|---|
| `markdown_index/smoke.md` | 1 | 5 | yes | no | paired — Phase 11 |

## mcp-ui (1 scenarios)

| Scenario | Spec cases | Test declarations | Playwright | Fast path | Coverage disposition |
|---|---:|---:|---|---|---|
| `mcp-ui/mcp_ui_vibe_form.md.ts` | — | 1 | yes | no | executable only — Phase 11 |

## nav-collapse (1 scenarios)

| Scenario | Spec cases | Test declarations | Playwright | Fast path | Coverage disposition |
|---|---:|---:|---|---|---|
| `nav-collapse/nav_collapse.md.ts` | — | 10 | yes | no | executable only — Phase 11 |

## sandbox (1 scenarios)

| Scenario | Spec cases | Test declarations | Playwright | Fast path | Coverage disposition |
|---|---:|---:|---|---|---|
| `sandbox/sandbox_share_link.md` | 11 | — | no | no | manual: true — excluded from Phase 12 |

## search (8 scenarios)

| Scenario | Spec cases | Test declarations | Playwright | Fast path | Coverage disposition |
|---|---:|---:|---|---|---|
| `search/mcp_index.md` | 5 | 3 | yes | no | paired — Phase 11 |
| `search/rebuild_index_ui.md` | 11 | 4 | yes | no | paired — Phase 11 |
| `search/record_search_from_home.md` | 3 | 3 | yes | no | paired — Phase 11 |
| `search/record_search_view.md` | 4 | 4 | yes | `_fast_paths/search/record_search_view.fast.ts` | paired — Phase 11 |
| `search/scan_records_viewer.md` | 3 | 3 | yes | no | paired — Phase 11 |
| `search/search_bar.md` | 6 | 6 | yes | no | paired — Phase 11 |
| `search/search_limit_param.md` | 1 | 1 | yes | no | paired — Phase 11 |
| `search/search_scan_info_stats.md` | 6 | 6 | yes | no | paired — Phase 11 |

## setup (2 scenarios)

| Scenario | Spec cases | Test declarations | Playwright | Fast path | Coverage disposition |
|---|---:|---:|---|---|---|
| `setup/llm_not_configured_shows_up_after_configuring_llm.md` | 2 | 2 | yes | no | paired — Phase 11 |
| `setup/login_with_anthropic_error_500.md` | 1 | 1 | yes | no | paired — Phase 11 |

## skills (7 scenarios)

| Scenario | Spec cases | Test declarations | Playwright | Fast path | Coverage disposition |
|---|---:|---:|---|---|---|
| `skills/console_error_404_skill_page.md` | 1 | 1 | yes | no | paired — Phase 11 |
| `skills/full_analysis_flow.md.ts` | — | 1 | yes | no | executable only — Phase 11 |
| `skills/skill_editor_error_skillparseerror_invalid_skillmd_format_mi.md` | 1 | 1 | yes | no | paired — Phase 11 |
| `skills/skills_failed_to_run_skill_console_error_482.md` | 1 | 1 | yes | no | paired — Phase 11 |
| `skills/skills_run_hangs_indefinitely.md` | 1 | 1 | yes | no | paired — Phase 11 |
| `skills/user_skills_failed_to_generate_plan_console_error_404.md` | 1 | 1 | yes | no | paired — Phase 11 |
| `skills/user_skills_failed_to_generate_plan_console_error_500.md` | 1 | 1 | yes | no | paired — Phase 11 |

## sniffer (4 scenarios)

| Scenario | Spec cases | Test declarations | Playwright | Fast path | Coverage disposition |
|---|---:|---:|---|---|---|
| `sniffer/sniffer_bootstrap_init_state.md` | 2 | 2 | yes | no | paired — Phase 11 |
| `sniffer/sniffer_event_capture.md` | 2 | 2 | yes | no | paired — Phase 11 |
| `sniffer/sniffer_shared_state_single_backend_call.md` | 1 | 1 | yes | no | paired — Phase 11 |
| `sniffer/sniffer_spa_navigation_preserves_state.md` | 1 | 1 | yes | no | paired — Phase 11 |

## tab_management (2 scenarios)

| Scenario | Spec cases | Test declarations | Playwright | Fast path | Coverage disposition |
|---|---:|---:|---|---|---|
| `tab_management/tab_lifecycle.md.ts` | — | 5 | yes | no | executable only — Phase 11 |
| `tab_management/tab_reorder.md.ts` | — | 1 | yes | no | executable only — Phase 11 |

## terminal (37 scenarios)

| Scenario | Spec cases | Test declarations | Playwright | Fast path | Coverage disposition |
|---|---:|---:|---|---|---|
| `terminal/ctrlc_doesnt_copy_in_shell_tab.md` | 1 | 1 | yes | no | paired — Phase 11 |
| `terminal/debug_nav.md.ts` | — | 1 | yes | no | executable only — Phase 11 |
| `terminal/dir_panel_scroll.md.ts` | — | 1 | yes | no | executable only — Phase 11 |
| `terminal/flow_shell_tab_location.md` | 1 | 1 | yes | no | paired — Phase 11 |
| `terminal/git_status_panel.md` | 10 | 8 | yes | no | paired — Phase 11 |
| `terminal/in_claude_ctrlv_does_not_paste.md` | 1 | 1 | yes | no | paired — Phase 11 |
| `terminal/interactive_tabs_project_filtering_matrix.md` | 51 | 51 | yes | no | paired — Phase 11 |
| `terminal/multiple_terminal_tabs.md` | 1 | 1 | yes | no | paired — Phase 11 |
| `terminal/navigate_to_shell.md` | 1 | 1 | yes | no | paired — Phase 11 |
| `terminal/plain_shell_url_loads_silently.md.ts` | — | 1 | yes | no | executable only — Phase 11 |
| `terminal/prompt_index_panel.md` | 12 | 6 | yes | no | paired — Phase 11 |
| `terminal/run_basic_command.md` | 1 | 1 | yes | no | paired — Phase 11 |
| `terminal/sandbox_tab_cloud_icon.md.ts` | — | 1 | yes | no | executable only — Phase 11 |
| `terminal/sandbox_terminal_uname.md.ts` | — | 1 | yes | no | executable only — Phase 11 |
| `terminal/sandbox_two_tabs_roundtrip.md.ts` | — | 1 | yes | no | executable only — Phase 11 |
| `terminal/session_persistence_on_refresh.md` | 1 | 4 | yes | no | paired — Phase 11 |
| `terminal/session_resumes_after_sleep_wake.md` | 1 | 1 | yes | no | paired — Phase 11 |
| `terminal/shell_slow_to_start_powershell_only.md` | 1 | 1 | yes | no | paired — Phase 11 |
| `terminal/shell_starts_in_acceptable_time.md` | 1 | 1 | yes | no | paired — Phase 11 |
| `terminal/shell_tab_title_and_switch.md.ts` | — | 1 | yes | no | executable only — Phase 11 |
| `terminal/shell_tabs_remain_open_after_closing.md` | 1 | 1 | yes | no | paired — Phase 11 |
| `terminal/shell_terminals_looks_empty.md` | 1 | 1 | yes | no | paired — Phase 11 |
| `terminal/terminal_annotation_bookmark.md` | 5 | 3 | yes | no | paired — Phase 11 |
| `terminal/terminal_clear_and_scrollback.md` | 1 | 1 | yes | no | paired — Phase 11 |
| `terminal/terminal_command_history.md` | 1 | 1 | yes | no | paired — Phase 11 |
| `terminal/terminal_ctrl_c.md` | 1 | 1 | yes | no | paired — Phase 11 |
| `terminal/terminal_persistence_on_tab_switch.md` | 1 | 1 | yes | no | paired — Phase 11 |
| `terminal/terminal_pty_no_duplicates.md` | 1 | 1 | yes | no | paired — Phase 11 |
| `terminal/terminal_pty_output_clean.md` | 1 | 1 | yes | no | paired — Phase 11 |
| `terminal/terminal_resize.md` | 1 | 1 | yes | no | paired — Phase 11 |
| `terminal/terminal_scroll_sync.md` | 2 | 2 | yes | no | paired — Phase 11 |
| `terminal/terminal_tab_rename.md` | 1 | 1 | yes | no | paired — Phase 11 |
| `terminal/terminal_tab_switch_no_duplicates.md.ts` | — | 1 | yes | no | executable only — Phase 11 |
| `terminal/time_gutter_and_prompt_annotations.md` | 10 | 10 | yes | no | paired — Phase 11 |
| `terminal/visible_process_still_pty.md` | 1 | 1 | yes | no | paired — Phase 11 |
| `terminal/web_app_artifact_not_created_when_prompted.md` | 1 | 1 | yes | no | paired — Phase 11 |
| `terminal/when_claude_runs_in_shell_and_is_thinking_not_all_the_output.md` | 1 | 1 | yes | no | paired — Phase 11 |

## triggers (5 scenarios)

| Scenario | Spec cases | Test declarations | Playwright | Fast path | Coverage disposition |
|---|---:|---:|---|---|---|
| `triggers/cron_view_redirects_to_triggers.md.ts` | — | 1 | yes | no | executable only — Phase 11 |
| `triggers/hook_trigger_still_works.md.ts` | — | 1 | yes | no | executable only — Phase 11 |
| `triggers/schedule_trigger_create_edit.md.ts` | — | 1 | yes | no | executable only — Phase 11 |
| `triggers/schedule_trigger_fires_test.md.ts` | — | 1 | yes | no | executable only — Phase 11 |
| `triggers/trigger_process_target_typeid_str.md` | 1 | 1 | yes | no | paired — Phase 11 |

## vibe (2 scenarios)

| Scenario | Spec cases | Test declarations | Playwright | Fast path | Coverage disposition |
|---|---:|---:|---|---|---|
| `vibe/vibe_bugs.md` | 1 | 4 | yes | no | paired — Phase 11 |
| `vibe/vibe_workspace_matrix.md` | 1 | 8 | yes | no | paired — Phase 11 |

## whiteboard (8 scenarios)

| Scenario | Spec cases | Test declarations | Playwright | Fast path | Coverage disposition |
|---|---:|---:|---|---|---|
| `whiteboard/create_persist.md` | 1 | 4 | yes | no | paired — Phase 11 |
| `whiteboard/edge_cases.md` | 1 | 5 | yes | no | paired — Phase 11 |
| `whiteboard/mermaid_sync.md` | 1 | 5 | yes | no | paired — Phase 11 |
| `whiteboard/multi_tab.md` | 1 | 1 | yes | no | paired — Phase 11 |
| `whiteboard/scope.md` | 1 | 2 | yes | no | paired — Phase 11 |
| `whiteboard/smoke.md` | 1 | 3 | yes | no | paired — Phase 11 |
| `whiteboard/ui_ux.md` | 1 | 4 | yes | no | paired — Phase 11 |
| `whiteboard/wiki_integration.md` | 1 | 1 | yes | no | paired — Phase 11 |

## wiki (1 scenarios)

| Scenario | Spec cases | Test declarations | Playwright | Fast path | Coverage disposition |
|---|---:|---:|---|---|---|
| `wiki/wiki_link_layer.md` | 23 | 3 | yes | no | paired — Phase 11 |

## Supplementary executable suites

These `.spec.ts` suites have their own category configurations and must be accounted for separately: a `.md.ts`-only sweep does not collect them.

| Scenario | Test declarations | Config |
|---|---:|---|
| `graph-workflows/demo-workflows.spec.ts` | 2 | `graph-workflows/playwright.config.ts` |
| `tags/tag-vocabulary.spec.ts` | 2 | `tags/playwright.config.ts` |

## Phase 12 filesystem coverage

- `data-sources/attached_channels.md` — executable sibling missing.
- `sandbox/sandbox_share_link.md` — explicit `manual: true`; excluded from authoring scope and visible as a coverage gap.
