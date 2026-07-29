# Test Index

> Last updated: 2026-07-29T02:09:43Z
> Scope: all manual-regression `.md` scenarios, `.md.ts` Playwright files, and standalone browser specs.

## agentic-process (md=13, md.ts=16, spec.ts=0)

| Scenario | Tests | Playwright | Fast Path | Skip |
|----------|------:|------------|-----------|------|
| agentic_process_visible_restored_on_load.md.ts *(md.ts only)* | 1 | yes | no | - |
| codex_chat_terminal_full_matrix.md | 2 | yes | no | - |
| codex_chat_terminal_switch_matrix.md | 2 | yes | no | - |
| conversation_view_three_spawn_branches.md | 2 | yes | no | - |
| embedded_close_preserves_process.md | 1 | yes | no | - |
| new_claude_session_no_console_errors.md | 1 | yes | no | - |
| observability_surfaces.md | 3 | yes | no | - |
| open_shell_from_process_workdir.md | 2 | yes | no | - |
| process_restart_and_cli_flags.md | 4 | yes | no | - |
| process_terminal_shell_tab_navigates_url.md | 1 | yes | no | - |
| processtoolbar_fork.md | 2 | yes | no | - |
| quick_create_session_browser_url_order.md.ts *(md.ts only)* | 1 | yes | no | - |
| resume_session_from_recent.md | 2 | yes | no | other (challenge) |
| session_info_popover.md | 3 | yes | no | - |
| shell_url_recovers_linked_process.md.ts *(md.ts only)* | 1 | yes | no | - |
| worktree_lifecycle.md | 2 | yes | no | - |

## assets (md=3, md.ts=4, spec.ts=0)

| Scenario | Tests | Playwright | Fast Path | Skip |
|----------|------:|------------|-----------|------|
| asset_id_collisions.md | 2 | yes | no | - |
| assets_list_mode.md | 6 | yes | no | - |
| vfs_files_tree_selection.md.ts *(md.ts only)* | 1 | yes | no | - |
| wiki_folder_tree.md | 4 | yes | no | other (challenge) |

## chat (md=19, md.ts=19, spec.ts=0)

| Scenario | Tests | Playwright | Fast Path | Skip |
|----------|------:|------------|-----------|------|
| 401_unauthorized_when_closing_a_chat.md | 1 | yes | no | - |
| chat_input_controls.md | 3 | yes | no | - |
| chat_refresh_persistence.md | 1 | yes | no | - |
| chat_tab_switching.md | 1 | yes | no | - |
| closing_a_chat_produces_console_error_401.md | 1 | yes | no | - |
| doc_chat_per_type.md | 5 | yes | no | live-claude |
| first_chat_message_is_slow.md | 1 | yes | no | - |
| in_chats_expanding_agent_thinking_component_is_not_retained.md | 1 | yes | no | - |
| landing_to_new_chat.md | 1 | yes | no | - |
| new_session_is_not_opened.md | 1 | yes | no | - |
| new_sessions_always_opened_with_session_1_header.md | 1 | yes | no | - |
| opening_project_in_explorer_console_error_404.md | 1 | yes | no | - |
| prompting_from_app_homepage_does_not_start_new_session.md | 1 | yes | no | - |
| prompting_to_start_new_session_from_app_homepage_does_not_wo.md | 1 | yes | no | - |
| return_to_home.md | 1 | yes | no | - |
| send_multiple_messages.md | 2 | yes | no | - |
| sessions_disappear_after_page_refresh.md | 1 | yes | no | - |
| switch_between_sessions.md | 1 | yes | no | - |
| while_agent_is_executing_refresh_clears_previous_thinking_se.md | 1 | yes | no | - |

## cli-log (md=1, md.ts=1, spec.ts=0)

| Scenario | Tests | Playwright | Fast Path | Skip |
|----------|------:|------------|-----------|------|
| cli_log_viewer.md | 3 | yes | yes | - |

## collaboration (md=7, md.ts=8, spec.ts=0)

| Scenario | Tests | Playwright | Fast Path | Skip |
|----------|------:|------------|-----------|------|
| collaboration_room_add_process.md | 1 | yes | no | - |
| doc_comment_create_sync.md | 1 | yes | no | - |
| doc_comment_delete_sync.md | 1 | yes | no | - |
| doc_comment_update_sync.md | 1 | yes | no | - |
| flowpad_assistant_docs_panel.md | 3 | yes | no | - |
| project_git_invite_browser.md.ts *(md.ts only)* | 1 | yes | no | - |
| project_room_new_doc.md | 3 | yes | no | - |
| project_row_opens_collab_space.md | 3 | yes | no | - |

## conversation (md=2, md.ts=2, spec.ts=0)

| Scenario | Tests | Playwright | Fast Path | Skip |
|----------|------:|------------|-----------|------|
| conversation_title_rename_live.md | 1 | yes | no | - |
| two_instance_hub_conversation.md | 2 | yes | no | other (challenge) |

## docs (md=4, md.ts=4, spec.ts=0)

| Scenario | Tests | Playwright | Fast Path | Skip |
|----------|------:|------------|-----------|------|
| v0.28_scenarios/LLM_comfigure.md | 1 | yes | no | - |
| v0.28_scenarios/coding_agent_cli.md | 1 | yes | no | - |
| v0.28_scenarios/environment_tab.md | 1 | yes | no | - |
| v0.28_scenarios/shell_tab.md | 1 | yes | no | - |

## editor (md=13, md.ts=13, spec.ts=0)

| Scenario | Tests | Playwright | Fast Path | Skip |
|----------|------:|------------|-----------|------|
| ami_creating_a_folder_crashes_desktop_app_agent_id_is_missin.md | 1 | yes | no | - |
| console_error_404_request_failed_with_status_code_404_when_c.md | 1 | yes | no | - |
| console_error_500_failed_to_load_resource_tab_hooks_in_syste.md | 1 | yes | no | - |
| editor_download_all_files_console_error.md | 1 | yes | no | - |
| editor_tab_download_all_files_fails_to_create_zip.md | 1 | yes | no | - |
| editorfiles_tab_creating_a_new_file_doesnt_show_the_file_in.md | 1 | yes | no | - |
| execute_flow_error_theme_vs_dark_not_found_you_may_need_to_l.md | 1 | yes | no | - |
| files_tab_download_directory_does_nothing.md | 1 | yes | no | - |
| files_tab_shows_local_c_as_root_and_doesnt_show_the_temp_wor.md | 1 | yes | no | - |
| milkdown_no_wiki_back_button.md | 1 | yes | no | - |
| milkdown_selection_toolbar.md | 6 | yes | no | - |
| new_prompt_save_indefinitely.md | 1 | yes | no | - |
| uploading_a_file_doesnt_show_up_in_the_side_bar.md | 1 | yes | no | - |

## general (md=8, md.ts=8, spec.ts=0)

| Scenario | Tests | Playwright | Fast Path | Skip |
|----------|------:|------------|-----------|------|
| app_slow_before_clearing_database.md | 1 | yes | no | - |
| console_error_482_failed_to_start_in_app_hompage.md | 1 | yes | no | - |
| current_activity_recent_sessions.md | 5 | yes | no | - |
| execute_flow_hangs_indefinitely.md | 1 | yes | no | - |
| heartbeat_sniffer_hook_events_e2e.md | 2 | yes | no | - |
| mac_desktop_app_hompage_error_500_failed_to_load_system_reso.md | 1 | yes | no | - |
| refreshing_any_tab_other_than_main_app_error_404_agent_id_mi.md | 2 | yes | no | - |
| usage_cost_failed_to_fetch_cost_overview.md | 1 | yes | no | - |

## k_browser (md=1, md.ts=1, spec.ts=0)

| Scenario | Tests | Playwright | Fast Path | Skip |
|----------|------:|------------|-----------|------|
| atlas_status_and_diff.md | 1 | yes | no | - |

## markdown_index (md=1, md.ts=1, spec.ts=0)

| Scenario | Tests | Playwright | Fast Path | Skip |
|----------|------:|------------|-----------|------|
| smoke.md | 6 | yes | no | live-claude |

## mcp-ui (md=0, md.ts=1, spec.ts=0)

| Scenario | Tests | Playwright | Fast Path | Skip |
|----------|------:|------------|-----------|------|
| mcp_ui_vibe_form.md.ts *(md.ts only)* | 3 | yes | no | other (challenge) |

## search (md=8, md.ts=8, spec.ts=0)

| Scenario | Tests | Playwright | Fast Path | Skip |
|----------|------:|------------|-----------|------|
| mcp_index.md | 5 | yes | no | other (challenge) |
| rebuild_index_ui.md | 4 | yes | no | - |
| record_search_from_home.md | 3 | yes | no | - |
| record_search_view.md | 4 | yes | yes | - |
| scan_records_viewer.md | 3 | yes | no | - |
| search_bar.md | 6 | yes | no | - |
| search_limit_param.md | 1 | yes | no | - |
| search_scan_info_stats.md | 6 | yes | no | - |

## setup (md=2, md.ts=2, spec.ts=0)

| Scenario | Tests | Playwright | Fast Path | Skip |
|----------|------:|------------|-----------|------|
| llm_not_configured_shows_up_after_configuring_llm.md | 2 | yes | no | - |
| login_with_anthropic_error_500.md | 1 | yes | no | - |

## skills (md=6, md.ts=7, spec.ts=0)

| Scenario | Tests | Playwright | Fast Path | Skip |
|----------|------:|------------|-----------|------|
| console_error_404_skill_page.md | 1 | yes | no | - |
| full_analysis_flow.md.ts *(md.ts only)* | 1 | yes | no | - |
| skill_editor_error_skillparseerror_invalid_skillmd_format_mi.md | 1 | yes | no | - |
| skills_failed_to_run_skill_console_error_482.md | 1 | yes | no | - |
| skills_run_hangs_indefinitely.md | 1 | yes | no | - |
| user_skills_failed_to_generate_plan_console_error_404.md | 1 | yes | no | - |
| user_skills_failed_to_generate_plan_console_error_500.md | 1 | yes | no | - |

## sniffer (md=4, md.ts=4, spec.ts=0)

| Scenario | Tests | Playwright | Fast Path | Skip |
|----------|------:|------------|-----------|------|
| sniffer_bootstrap_init_state.md | 2 | yes | no | - |
| sniffer_event_capture.md | 2 | yes | no | - |
| sniffer_shared_state_single_backend_call.md | 1 | yes | no | - |
| sniffer_spa_navigation_preserves_state.md | 1 | yes | no | - |

## tab_management (md=0, md.ts=2, spec.ts=0)

| Scenario | Tests | Playwright | Fast Path | Skip |
|----------|------:|------------|-----------|------|
| tab_lifecycle.md.ts *(md.ts only)* | 5 | yes | no | - |
| tab_reorder.md.ts *(md.ts only)* | 1 | yes | no | - |

## tags (md=0, md.ts=0, spec.ts=1)

| Scenario | Tests | Playwright | Fast Path | Skip |
|----------|------:|------------|-----------|------|
| tag-vocabulary.spec.ts *(standalone spec)* | 2 | yes | no | - |

## terminal (md=29, md.ts=40, spec.ts=0)

| Scenario | Tests | Playwright | Fast Path | Skip |
|----------|------:|------------|-----------|------|
| ctrlc_doesnt_copy_in_shell_tab.md | 1 | yes | no | - |
| debug_nav.md.ts *(md.ts only)* | 1 | yes | no | - |
| dir_panel_scroll.md.ts *(md.ts only)* | 2 | yes | no | other (challenge) |
| docker_stale_shell_reopen.md.ts *(md.ts only)* | 2 | yes | no | other (challenge) |
| docker_terminal_uname.md.ts *(md.ts only)* | 2 | yes | no | other (challenge) |
| docker_two_tabs_roundtrip.md.ts *(md.ts only)* | 2 | yes | no | other (challenge) |
| flow_shell_tab_location.md | 1 | yes | no | - |
| git_status_panel.md | 12 | yes | no | other (challenge) |
| in_claude_ctrlv_does_not_paste.md | 1 | yes | no | - |
| interactive_tabs_project_filtering_matrix.md | 51 | yes | no | platform |
| multiple_terminal_tabs.md | 1 | yes | no | - |
| navigate_to_shell.md | 1 | yes | no | - |
| plain_shell_url_loads_silently.md.ts *(md.ts only)* | 1 | yes | no | - |
| prompt_index_panel.md | 7 | yes | no | other (challenge) |
| run_basic_command.md | 1 | yes | no | - |
| sandbox_tab_cloud_icon.md.ts *(md.ts only)* | 2 | yes | no | other (challenge) |
| sandbox_terminal_uname.md.ts *(md.ts only)* | 2 | yes | no | other (challenge) |
| sandbox_two_tabs_roundtrip.md.ts *(md.ts only)* | 2 | yes | no | other (challenge) |
| session_persistence_on_refresh.md | 4 | yes | no | - |
| session_resumes_after_sleep_wake.md | 1 | yes | no | - |
| shell_slow_to_start_powershell_only.md | 2 | yes | no | platform |
| shell_starts_in_acceptable_time.md | 1 | yes | no | - |
| shell_tab_title_and_switch.md.ts *(md.ts only)* | 1 | yes | no | - |
| shell_tabs_remain_open_after_closing.md | 1 | yes | no | - |
| shell_terminals_looks_empty.md | 1 | yes | no | - |
| terminal_annotation_bookmark.md | 4 | yes | no | other (challenge) |
| terminal_clear_and_scrollback.md | 1 | yes | no | - |
| terminal_command_history.md | 1 | yes | no | - |
| terminal_ctrl_c.md | 1 | yes | no | - |
| terminal_persistence_on_tab_switch.md | 1 | yes | no | - |
| terminal_pty_no_duplicates.md | 1 | yes | no | - |
| terminal_pty_output_clean.md | 1 | yes | no | - |
| terminal_resize.md | 1 | yes | no | - |
| terminal_scroll_sync.md | 2 | yes | no | - |
| terminal_tab_rename.md | 1 | yes | no | - |
| terminal_tab_switch_no_duplicates.md.ts *(md.ts only)* | 1 | yes | no | - |
| time_gutter_and_prompt_annotations.md | 20 | yes | no | live-claude |
| visible_process_still_pty.md | 2 | yes | no | other (challenge) |
| web_app_artifact_not_created_when_prompted.md | 1 | yes | no | - |
| when_claude_runs_in_shell_and_is_thinking_not_all_the_output.md | 1 | yes | no | - |

## triggers (md=1, md.ts=5, spec.ts=0)

| Scenario | Tests | Playwright | Fast Path | Skip |
|----------|------:|------------|-----------|------|
| cron_view_redirects_to_triggers.md.ts *(md.ts only)* | 1 | yes | no | - |
| hook_trigger_still_works.md.ts *(md.ts only)* | 1 | yes | no | - |
| schedule_trigger_create_edit.md.ts *(md.ts only)* | 1 | yes | no | other (challenge) |
| schedule_trigger_fires_test.md.ts *(md.ts only)* | 1 | yes | no | other (challenge) |
| trigger_process_target_typeid_str.md | 1 | yes | no | - |

## vibe (md=2, md.ts=2, spec.ts=0)

| Scenario | Tests | Playwright | Fast Path | Skip |
|----------|------:|------------|-----------|------|
| vibe_bugs.md | 4 | yes | no | - |
| vibe_workspace_matrix.md | 5 | yes | no | - |

## whiteboard (md=8, md.ts=8, spec.ts=0)

| Scenario | Tests | Playwright | Fast Path | Skip |
|----------|------:|------------|-----------|------|
| create_persist.md | 4 | yes | no | - |
| edge_cases.md | 5 | yes | no | - |
| mermaid_sync.md | 5 | yes | no | - |
| multi_tab.md | 1 | yes | no | - |
| scope.md | 2 | yes | no | - |
| smoke.md | 3 | yes | no | - |
| ui_ux.md | 4 | yes | no | - |
| wiki_integration.md | 2 | yes | no | other (challenge) |

## wiki (md=1, md.ts=1, spec.ts=0)

| Scenario | Tests | Playwright | Fast Path | Skip |
|----------|------:|------------|-----------|------|
| wiki_link_layer.md | 3 | yes | no | - |

---

TOTAL: md=133, md.ts=157, spec.ts=1, orphan .md (Phase 12 scope)=0
