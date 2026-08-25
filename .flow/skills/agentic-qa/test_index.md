# Manual Regression Test Index

_Generated 2026-08-24T22:20:31Z by the e2e-qa skill (QA Cycle). Convenience view only — the authoritative orphan set is the `comm -23` filesystem diff in `modes/qa-cycle.md` Phase 12._

Scenarios dir: `ui/tests/manual_regression`

| Category | .md specs | .md.ts tests | orphan .md (Phase 12 scope) | playwright.config.ts |
|---|---|---|---|---|
| agentic-process | 14 | 17 | — | yes |
| assets | 3 | 4 | — | yes |
| chat | 19 | 19 | — | yes |
| cli-log | 1 | 1 | — | yes |
| collaboration | 7 | 8 | — | yes |
| conversation | 2 | 2 | — | yes |
| data-sources | 2 | 1 | credentialed_sources | yes |
| dock-sweep | 1 | 1 | — | yes |
| docs | 0 | 0 | — | yes |
| editor | 14 | 14 | — | yes |
| general | 8 | 9 | — | yes |
| graph-workflows | 0 | 0 | — | yes |
| journey-sweep | 0 | 1 | — | yes |
| k_browser | 1 | 1 | — | yes |
| markdown_index | 1 | 1 | — | yes |
| mcp-ui | 0 | 1 | — | yes |
| nav-collapse | 0 | 1 | — | yes |
| sandbox | 1 | 0 | sandbox_share_link | — |
| search | 8 | 8 | — | yes |
| setup | 2 | 2 | — | yes |
| skills | 6 | 7 | — | yes |
| sniffer | 4 | 4 | — | yes |
| tab_management | 0 | 2 | — | yes |
| tags | 0 | 0 | — | yes |
| terminal | 29 | 37 | — | yes |
| triggers | 1 | 5 | — | yes |
| vibe | 2 | 2 | — | yes |
| whiteboard | 8 | 8 | — | yes |
| wiki | 1 | 1 | — | yes |
| (root) | 2 | 2 | — | yes |

**Totals:** 137 `.md` specs, 159 `.md.ts` Playwright tests, 2 orphan `.md`.

## Per-category scenario listing

### agentic-process
- `codex_chat_terminal_full_matrix.md` → `codex_chat_terminal_full_matrix.md.ts` ✓
- `codex_chat_terminal_switch_matrix.md` → `codex_chat_terminal_switch_matrix.md.ts` ✓
- `conversation_view_three_spawn_branches.md` → `conversation_view_three_spawn_branches.md.ts` ✓
- `embedded_close_preserves_process.md` → `embedded_close_preserves_process.md.ts` ✓
- `new_claude_session_no_console_errors.md` → `new_claude_session_no_console_errors.md.ts` ✓
- `observability_surfaces.md` → `observability_surfaces.md.ts` ✓
- `opencode_pty_composer_boots.md` → `opencode_pty_composer_boots.md.ts` ✓
- `open_shell_from_process_workdir.md` → `open_shell_from_process_workdir.md.ts` ✓
- `process_restart_and_cli_flags.md` → `process_restart_and_cli_flags.md.ts` ✓
- `process_terminal_shell_tab_navigates_url.md` → `process_terminal_shell_tab_navigates_url.md.ts` ✓
- `processtoolbar_fork.md` → `processtoolbar_fork.md.ts` ✓
- `resume_session_from_recent.md` → `resume_session_from_recent.md.ts` ✓
- `session_info_popover.md` → `session_info_popover.md.ts` ✓
- `worktree_lifecycle.md` → `worktree_lifecycle.md.ts` ✓
- `agentic_process_visible_restored_on_load.md.ts` (no .md spec — Phase 11 only)
- `quick_create_session_browser_url_order.md.ts` (no .md spec — Phase 11 only)
- `shell_url_recovers_linked_process.md.ts` (no .md spec — Phase 11 only)

### assets
- `asset_id_collisions.md` → `asset_id_collisions.md.ts` ✓
- `assets_list_mode.md` → `assets_list_mode.md.ts` ✓
- `wiki_folder_tree.md` → `wiki_folder_tree.md.ts` ✓
- `vfs_files_tree_selection.md.ts` (no .md spec — Phase 11 only)

### chat
- `401_unauthorized_when_closing_a_chat.md` → `401_unauthorized_when_closing_a_chat.md.ts` ✓
- `chat_input_controls.md` → `chat_input_controls.md.ts` ✓
- `chat_refresh_persistence.md` → `chat_refresh_persistence.md.ts` ✓
- `chat_tab_switching.md` → `chat_tab_switching.md.ts` ✓
- `closing_a_chat_produces_console_error_401.md` → `closing_a_chat_produces_console_error_401.md.ts` ✓
- `doc_chat_per_type.md` → `doc_chat_per_type.md.ts` ✓
- `first_chat_message_is_slow.md` → `first_chat_message_is_slow.md.ts` ✓
- `in_chats_expanding_agent_thinking_component_is_not_retained.md` → `in_chats_expanding_agent_thinking_component_is_not_retained.md.ts` ✓
- `landing_to_new_chat.md` → `landing_to_new_chat.md.ts` ✓
- `new_session_is_not_opened.md` → `new_session_is_not_opened.md.ts` ✓
- `new_sessions_always_opened_with_session_1_header.md` → `new_sessions_always_opened_with_session_1_header.md.ts` ✓
- `opening_project_in_explorer_console_error_404.md` → `opening_project_in_explorer_console_error_404.md.ts` ✓
- `prompting_from_app_homepage_does_not_start_new_session.md` → `prompting_from_app_homepage_does_not_start_new_session.md.ts` ✓
- `prompting_to_start_new_session_from_app_homepage_does_not_wo.md` → `prompting_to_start_new_session_from_app_homepage_does_not_wo.md.ts` ✓
- `return_to_home.md` → `return_to_home.md.ts` ✓
- `send_multiple_messages.md` → `send_multiple_messages.md.ts` ✓
- `sessions_disappear_after_page_refresh.md` → `sessions_disappear_after_page_refresh.md.ts` ✓
- `switch_between_sessions.md` → `switch_between_sessions.md.ts` ✓
- `while_agent_is_executing_refresh_clears_previous_thinking_se.md` → `while_agent_is_executing_refresh_clears_previous_thinking_se.md.ts` ✓

### cli-log
- `cli_log_viewer.md` → `cli_log_viewer.md.ts` ✓

### collaboration
- `collaboration_room_add_process.md` → `collaboration_room_add_process.md.ts` ✓
- `doc_comment_create_sync.md` → `doc_comment_create_sync.md.ts` ✓
- `doc_comment_delete_sync.md` → `doc_comment_delete_sync.md.ts` ✓
- `doc_comment_update_sync.md` → `doc_comment_update_sync.md.ts` ✓
- `flowpad_assistant_docs_panel.md` → `flowpad_assistant_docs_panel.md.ts` ✓
- `project_room_new_doc.md` → `project_room_new_doc.md.ts` ✓
- `project_row_opens_collab_space.md` → `project_row_opens_collab_space.md.ts` ✓
- `project_git_invite_browser.md.ts` (no .md spec — Phase 11 only)

### conversation
- `conversation_title_rename_live.md` → `conversation_title_rename_live.md.ts` ✓
- `two_instance_hub_conversation.md` → `two_instance_hub_conversation.md.ts` ✓

### data-sources
- `backend_served_sources.md` → `backend_served_sources.md.ts` ✓
- `credentialed_sources.md` → **NO .md.ts (orphan)**

### dock-sweep
- `dock_sweep.md` → `dock_sweep.md.ts` ✓

### editor
- `ami_creating_a_folder_crashes_desktop_app_agent_id_is_missin.md` → `ami_creating_a_folder_crashes_desktop_app_agent_id_is_missin.md.ts` ✓
- `breadcrumb_fence.md` → `breadcrumb_fence.md.ts` ✓
- `console_error_404_request_failed_with_status_code_404_when_c.md` → `console_error_404_request_failed_with_status_code_404_when_c.md.ts` ✓
- `console_error_500_failed_to_load_resource_tab_hooks_in_syste.md` → `console_error_500_failed_to_load_resource_tab_hooks_in_syste.md.ts` ✓
- `editor_download_all_files_console_error.md` → `editor_download_all_files_console_error.md.ts` ✓
- `editorfiles_tab_creating_a_new_file_doesnt_show_the_file_in.md` → `editorfiles_tab_creating_a_new_file_doesnt_show_the_file_in.md.ts` ✓
- `editor_tab_download_all_files_fails_to_create_zip.md` → `editor_tab_download_all_files_fails_to_create_zip.md.ts` ✓
- `execute_flow_error_theme_vs_dark_not_found_you_may_need_to_l.md` → `execute_flow_error_theme_vs_dark_not_found_you_may_need_to_l.md.ts` ✓
- `files_tab_download_directory_does_nothing.md` → `files_tab_download_directory_does_nothing.md.ts` ✓
- `files_tab_shows_local_c_as_root_and_doesnt_show_the_temp_wor.md` → `files_tab_shows_local_c_as_root_and_doesnt_show_the_temp_wor.md.ts` ✓
- `milkdown_no_wiki_back_button.md` → `milkdown_no_wiki_back_button.md.ts` ✓
- `milkdown_selection_toolbar.md` → `milkdown_selection_toolbar.md.ts` ✓
- `new_prompt_save_indefinitely.md` → `new_prompt_save_indefinitely.md.ts` ✓
- `uploading_a_file_doesnt_show_up_in_the_side_bar.md` → `uploading_a_file_doesnt_show_up_in_the_side_bar.md.ts` ✓

### general
- `app_slow_before_clearing_database.md` → `app_slow_before_clearing_database.md.ts` ✓
- `console_error_482_failed_to_start_in_app_hompage.md` → `console_error_482_failed_to_start_in_app_hompage.md.ts` ✓
- `current_activity_recent_sessions.md` → `current_activity_recent_sessions.md.ts` ✓
- `execute_flow_hangs_indefinitely.md` → `execute_flow_hangs_indefinitely.md.ts` ✓
- `heartbeat_sniffer_hook_events_e2e.md` → `heartbeat_sniffer_hook_events_e2e.md.ts` ✓
- `mac_desktop_app_hompage_error_500_failed_to_load_system_reso.md` → `mac_desktop_app_hompage_error_500_failed_to_load_system_reso.md.ts` ✓
- `refreshing_any_tab_other_than_main_app_error_404_agent_id_mi.md` → `refreshing_any_tab_other_than_main_app_error_404_agent_id_mi.md.ts` ✓
- `usage_cost_failed_to_fetch_cost_overview.md` → `usage_cost_failed_to_fetch_cost_overview.md.ts` ✓
- `cloudnsite-install.md.ts` (no .md spec — Phase 11 only)

### journey-sweep
- `journey_sweep.md.ts` (no .md spec — Phase 11 only)

### k_browser
- `atlas_status_and_diff.md` → `atlas_status_and_diff.md.ts` ✓

### markdown_index
- `smoke.md` → `smoke.md.ts` ✓

### mcp-ui
- `mcp_ui_vibe_form.md.ts` (no .md spec — Phase 11 only)

### nav-collapse
- `nav_collapse.md.ts` (no .md spec — Phase 11 only)

### sandbox
- `sandbox_share_link.md` → **NO .md.ts (orphan)**

### search
- `mcp_index.md` → `mcp_index.md.ts` ✓
- `rebuild_index_ui.md` → `rebuild_index_ui.md.ts` ✓
- `record_search_from_home.md` → `record_search_from_home.md.ts` ✓
- `record_search_view.md` → `record_search_view.md.ts` ✓
- `scan_records_viewer.md` → `scan_records_viewer.md.ts` ✓
- `search_bar.md` → `search_bar.md.ts` ✓
- `search_limit_param.md` → `search_limit_param.md.ts` ✓
- `search_scan_info_stats.md` → `search_scan_info_stats.md.ts` ✓

### setup
- `llm_not_configured_shows_up_after_configuring_llm.md` → `llm_not_configured_shows_up_after_configuring_llm.md.ts` ✓
- `login_with_anthropic_error_500.md` → `login_with_anthropic_error_500.md.ts` ✓

### skills
- `console_error_404_skill_page.md` → `console_error_404_skill_page.md.ts` ✓
- `skill_editor_error_skillparseerror_invalid_skillmd_format_mi.md` → `skill_editor_error_skillparseerror_invalid_skillmd_format_mi.md.ts` ✓
- `skills_failed_to_run_skill_console_error_482.md` → `skills_failed_to_run_skill_console_error_482.md.ts` ✓
- `skills_run_hangs_indefinitely.md` → `skills_run_hangs_indefinitely.md.ts` ✓
- `user_skills_failed_to_generate_plan_console_error_404.md` → `user_skills_failed_to_generate_plan_console_error_404.md.ts` ✓
- `user_skills_failed_to_generate_plan_console_error_500.md` → `user_skills_failed_to_generate_plan_console_error_500.md.ts` ✓
- `full_analysis_flow.md.ts` (no .md spec — Phase 11 only)

### sniffer
- `sniffer_bootstrap_init_state.md` → `sniffer_bootstrap_init_state.md.ts` ✓
- `sniffer_event_capture.md` → `sniffer_event_capture.md.ts` ✓
- `sniffer_shared_state_single_backend_call.md` → `sniffer_shared_state_single_backend_call.md.ts` ✓
- `sniffer_spa_navigation_preserves_state.md` → `sniffer_spa_navigation_preserves_state.md.ts` ✓

### tab_management
- `tab_lifecycle.md.ts` (no .md spec — Phase 11 only)
- `tab_reorder.md.ts` (no .md spec — Phase 11 only)

### terminal
- `ctrlc_doesnt_copy_in_shell_tab.md` → `ctrlc_doesnt_copy_in_shell_tab.md.ts` ✓
- `flow_shell_tab_location.md` → `flow_shell_tab_location.md.ts` ✓
- `git_status_panel.md` → `git_status_panel.md.ts` ✓
- `in_claude_ctrlv_does_not_paste.md` → `in_claude_ctrlv_does_not_paste.md.ts` ✓
- `interactive_tabs_project_filtering_matrix.md` → `interactive_tabs_project_filtering_matrix.md.ts` ✓
- `multiple_terminal_tabs.md` → `multiple_terminal_tabs.md.ts` ✓
- `navigate_to_shell.md` → `navigate_to_shell.md.ts` ✓
- `prompt_index_panel.md` → `prompt_index_panel.md.ts` ✓
- `run_basic_command.md` → `run_basic_command.md.ts` ✓
- `session_persistence_on_refresh.md` → `session_persistence_on_refresh.md.ts` ✓
- `session_resumes_after_sleep_wake.md` → `session_resumes_after_sleep_wake.md.ts` ✓
- `shell_slow_to_start_powershell_only.md` → `shell_slow_to_start_powershell_only.md.ts` ✓
- `shell_starts_in_acceptable_time.md` → `shell_starts_in_acceptable_time.md.ts` ✓
- `shell_tabs_remain_open_after_closing.md` → `shell_tabs_remain_open_after_closing.md.ts` ✓
- `shell_terminals_looks_empty.md` → `shell_terminals_looks_empty.md.ts` ✓
- `terminal_annotation_bookmark.md` → `terminal_annotation_bookmark.md.ts` ✓
- `terminal_clear_and_scrollback.md` → `terminal_clear_and_scrollback.md.ts` ✓
- `terminal_command_history.md` → `terminal_command_history.md.ts` ✓
- `terminal_ctrl_c.md` → `terminal_ctrl_c.md.ts` ✓
- `terminal_persistence_on_tab_switch.md` → `terminal_persistence_on_tab_switch.md.ts` ✓
- `terminal_pty_no_duplicates.md` → `terminal_pty_no_duplicates.md.ts` ✓
- `terminal_pty_output_clean.md` → `terminal_pty_output_clean.md.ts` ✓
- `terminal_resize.md` → `terminal_resize.md.ts` ✓
- `terminal_scroll_sync.md` → `terminal_scroll_sync.md.ts` ✓
- `terminal_tab_rename.md` → `terminal_tab_rename.md.ts` ✓
- `time_gutter_and_prompt_annotations.md` → `time_gutter_and_prompt_annotations.md.ts` ✓
- `visible_process_still_pty.md` → `visible_process_still_pty.md.ts` ✓
- `web_app_artifact_not_created_when_prompted.md` → `web_app_artifact_not_created_when_prompted.md.ts` ✓
- `when_claude_runs_in_shell_and_is_thinking_not_all_the_output.md` → `when_claude_runs_in_shell_and_is_thinking_not_all_the_output.md.ts` ✓
- `debug_nav.md.ts` (no .md spec — Phase 11 only)
- `dir_panel_scroll.md.ts` (no .md spec — Phase 11 only)
- `plain_shell_url_loads_silently.md.ts` (no .md spec — Phase 11 only)
- `sandbox_tab_cloud_icon.md.ts` (no .md spec — Phase 11 only)
- `sandbox_terminal_uname.md.ts` (no .md spec — Phase 11 only)
- `sandbox_two_tabs_roundtrip.md.ts` (no .md spec — Phase 11 only)
- `shell_tab_title_and_switch.md.ts` (no .md spec — Phase 11 only)
- `terminal_tab_switch_no_duplicates.md.ts` (no .md spec — Phase 11 only)

### triggers
- `trigger_process_target_typeid_str.md` → `trigger_process_target_typeid_str.md.ts` ✓
- `cron_view_redirects_to_triggers.md.ts` (no .md spec — Phase 11 only)
- `hook_trigger_still_works.md.ts` (no .md spec — Phase 11 only)
- `schedule_trigger_create_edit.md.ts` (no .md spec — Phase 11 only)
- `schedule_trigger_fires_test.md.ts` (no .md spec — Phase 11 only)

### vibe
- `vibe_bugs.md` → `vibe_bugs.md.ts` ✓
- `vibe_workspace_matrix.md` → `vibe_workspace_matrix.md.ts` ✓

### whiteboard
- `create_persist.md` → `create_persist.md.ts` ✓
- `edge_cases.md` → `edge_cases.md.ts` ✓
- `mermaid_sync.md` → `mermaid_sync.md.ts` ✓
- `multi_tab.md` → `multi_tab.md.ts` ✓
- `scope.md` → `scope.md.ts` ✓
- `smoke.md` → `smoke.md.ts` ✓
- `ui_ux.md` → `ui_ux.md.ts` ✓
- `wiki_integration.md` → `wiki_integration.md.ts` ✓

### wiki
- `wiki_link_layer.md` → `wiki_link_layer.md.ts` ✓
