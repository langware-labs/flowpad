# Test Index

> Last updated: 2026-06-07T06:48:39Z
> Scope: .md scenarios only. .md.ts-only files without a .md spec are not counted.

## agentic-process (12 scenarios)
| Scenario | Tests | Playwright | Fast Path | Skip |
|----------|-------|------------|-----------|------|
| conversation_view_three_spawn_branches.md | 1 | no | no | - |
| embedded_close_preserves_process.md | 1 | no | no | - |
| fork_action_from_search_dock.md | 1 | yes | no | - |
| new_claude_session_no_console_errors.md | 1 | yes | no | - |
| observability_surfaces.md | 1 | yes | no | - |
| open_shell_from_process_workdir.md | 1 | yes | no | - |
| process_restart_and_cli_flags.md | 1 | yes | no | - |
| process_terminal_shell_tab_navigates_url.md | 1 | yes | no | - |
| processtoolbar_fork.md | 1 | yes | no | - |
| resume_session_from_recent.md | 1 | yes | no | live-claude? |
| session_info_popover.md | 1 | yes | no | clipboard? |
| worktree_lifecycle.md | 1 | yes | no | - |

## assets (3 scenarios)
| Scenario | Tests | Playwright | Fast Path | Skip |
|----------|-------|------------|-----------|------|
| agent_execution_asset_picker.md | 9 | yes | no | - |
| assets_list_mode.md | 6 | yes | no | - |
| wiki_folder_tree.md | 1 | yes | no | - |

## chat (14 scenarios)
| Scenario | Tests | Playwright | Fast Path | Skip |
|----------|-------|------------|-----------|------|
| chat_input_controls.md | 2 | yes | no | - |
| chat_refresh_persistence.md | 1 | yes | no | - |
| chat_tab_switching.md | 1 | yes | no | - |
| closing_a_chat_produces_console_error_401.md | 1 | yes | no | - |
| doc_chat_per_type.md | 1 | yes | no | - |
| landing_to_new_chat.md | 1 | yes | no | - |
| new_session_is_not_opened.md | 1 | yes | no | - |
| new_sessions_always_opened_with_session_1_header.md | 1 | yes | no | - |
| opening_project_in_explorer_console_error_404.md | 1 | yes | no | - |
| prompting_from_app_homepage_does_not_start_new_session.md | 1 | yes | no | - |
| return_to_home.md | 1 | yes | no | - |
| send_multiple_messages.md | 1 | yes | no | - |
| sessions_disappear_after_page_refresh.md | 1 | yes | no | - |
| switch_between_sessions.md | 1 | yes | no | - |

## cli-log (1 scenarios)
| Scenario | Tests | Playwright | Fast Path | Skip |
|----------|-------|------------|-----------|------|
| cli_log_viewer.md | 1 | yes | yes | - |

## collaboration (4 scenarios)
| Scenario | Tests | Playwright | Fast Path | Skip |
|----------|-------|------------|-----------|------|
| collaboration_room_add_process.md | 1 | yes | no | - |
| flowpad_assistant_docs_panel.md | 1 | yes | no | - |
| project_room_new_doc.md | 1 | yes | no | - |
| project_row_opens_collab_space.md | 1 | yes | no | - |

## conversation (2 scenarios)
| Scenario | Tests | Playwright | Fast Path | Skip |
|----------|-------|------------|-----------|------|
| conversation_title_rename_live.md | 1 | yes | no | - |
| two_instance_hub_conversation.md | 1 | yes | no | - |

## editor (13 scenarios)
| Scenario | Tests | Playwright | Fast Path | Skip |
|----------|-------|------------|-----------|------|
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
| milkdown_selection_toolbar.md | 1 | yes | no | - |
| new_prompt_save_indefinitely.md | 1 | yes | no | - |
| uploading_a_file_doesnt_show_up_in_the_side_bar.md | 1 | yes | no | - |

## general (7 scenarios)
| Scenario | Tests | Playwright | Fast Path | Skip |
|----------|-------|------------|-----------|------|
| console_error_482_failed_to_start_in_app_hompage.md | 1 | yes | no | - |
| current_activity_recent_sessions.md | 1 | yes | no | - |
| execute_flow_hangs_indefinitely.md | 1 | yes | no | - |
| heartbeat_sniffer_hook_events_e2e.md | 1 | yes | no | - |
| mac_desktop_app_hompage_error_500_failed_to_load_system_reso.md | 1 | yes | no | - |
| refreshing_any_tab_other_than_main_app_error_404_agent_id_mi.md | 1 | yes | no | - |
| usage_cost_failed_to_fetch_cost_overview.md | 1 | yes | no | - |

## k_browser (1 scenarios)
| Scenario | Tests | Playwright | Fast Path | Skip |
|----------|-------|------------|-----------|------|
| atlas_status_and_diff.md | 1 | yes | no | - |

## markdown_index (1 scenarios)
| Scenario | Tests | Playwright | Fast Path | Skip |
|----------|-------|------------|-----------|------|
| smoke.md | 1 | yes | no | - |

## search (8 scenarios)
| Scenario | Tests | Playwright | Fast Path | Skip |
|----------|-------|------------|-----------|------|
| mcp_index.md | 1 | no | no | - |
| rebuild_index_ui.md | 1 | yes | no | - |
| record_search_from_home.md | 1 | yes | no | - |
| record_search_view.md | 1 | yes | yes | - |
| scan_records_viewer.md | 1 | yes | no | - |
| search_bar.md | 1 | yes | no | - |
| search_limit_param.md | 1 | yes | no | - |
| search_scan_info_stats.md | 1 | yes | no | - |

## setup (1 scenarios)
| Scenario | Tests | Playwright | Fast Path | Skip |
|----------|-------|------------|-----------|------|
| llm_not_configured_shows_up_after_configuring_llm.md | 1 | yes | no | - |

## skills (6 scenarios)
| Scenario | Tests | Playwright | Fast Path | Skip |
|----------|-------|------------|-----------|------|
| console_error_404_skill_page.md | 1 | yes | no | - |
| skill_editor_error_skillparseerror_invalid_skillmd_format_mi.md | 1 | yes | no | - |
| skills_failed_to_run_skill_console_error_482.md | 1 | yes | no | - |
| skills_run_hangs_indefinitely.md | 1 | yes | no | - |
| user_skills_failed_to_generate_plan_console_error_404.md | 1 | yes | no | - |
| user_skills_failed_to_generate_plan_console_error_500.md | 1 | yes | no | - |

## sniffer (4 scenarios)
| Scenario | Tests | Playwright | Fast Path | Skip |
|----------|-------|------------|-----------|------|
| sniffer_bootstrap_init_state.md | 1 | yes | no | - |
| sniffer_event_capture.md | 1 | yes | no | - |
| sniffer_shared_state_single_backend_call.md | 1 | yes | no | - |
| sniffer_spa_navigation_preserves_state.md | 1 | yes | no | - |

## terminal (26 scenarios)
| Scenario | Tests | Playwright | Fast Path | Skip |
|----------|-------|------------|-----------|------|
| ctrlc_doesnt_copy_in_shell_tab.md | 1 | yes | no | clipboard? |
| flow_shell_tab_location.md | 1 | yes | no | - |
| git_status_panel.md | 1 | yes | no | - |
| in_claude_ctrlv_does_not_paste.md | 1 | yes | no | clipboard? |
| interactive_tabs_project_filtering_matrix.md | 1 | yes | no | live-claude? |
| multiple_terminal_tabs.md | 1 | yes | no | - |
| navigate_to_shell.md | 1 | yes | no | - |
| prompt_index_panel.md | 1 | yes | no | - |
| run_basic_command.md | 1 | yes | no | - |
| shell_starts_in_acceptable_time.md | 1 | yes | no | - |
| shell_tabs_remain_open_after_closing.md | 1 | yes | no | - |
| shell_terminals_looks_empty.md | 1 | yes | no | - |
| terminal_annotation_bookmark.md | 1 | yes | no | - |
| terminal_clear_and_scrollback.md | 1 | yes | no | - |
| terminal_command_history.md | 1 | yes | no | - |
| terminal_ctrl_c.md | 1 | yes | no | - |
| terminal_persistence_on_tab_switch.md | 1 | yes | no | - |
| terminal_pty_no_duplicates.md | 1 | yes | no | - |
| terminal_pty_output_clean.md | 1 | yes | no | - |
| terminal_resize.md | 1 | yes | no | - |
| terminal_scroll_sync.md | 1 | yes | no | - |
| terminal_tab_rename.md | 1 | yes | no | - |
| time_gutter_and_prompt_annotations.md | 1 | yes | no | - |
| visible_process_still_pty.md | 1 | yes | no | - |
| web_app_artifact_not_created_when_prompted.md | 1 | yes | no | - |
| when_claude_runs_in_shell_and_is_thinking_not_all_the_output.md | 1 | yes | no | - |

## triggers (1 scenarios)
| Scenario | Tests | Playwright | Fast Path | Skip |
|----------|-------|------------|-----------|------|
| trigger_process_target_typeid_str.md | 1 | yes | no | - |

## whiteboard (8 scenarios)
| Scenario | Tests | Playwright | Fast Path | Skip |
|----------|-------|------------|-----------|------|
| create_persist.md | 1 | yes | no | - |
| edge_cases.md | 1 | yes | no | - |
| mermaid_sync.md | 1 | yes | no | - |
| multi_tab.md | 1 | yes | no | - |
| scope.md | 1 | yes | no | - |
| smoke.md | 1 | yes | no | - |
| ui_ux.md | 1 | yes | no | clipboard? |
| wiki_integration.md | 1 | yes | no | - |

## workflow (2 scenarios)
| Scenario | Tests | Playwright | Fast Path | Skip |
|----------|-------|------------|-----------|------|
| workflow_entity_create.md | 1 | yes | no | - |
| workflow_run_button.md | 1 | yes | no | - |
