"""ClaudeSettingsFsRecord -- root record from ~/.claude.json.

Contains all scalar top-level fields (identity, terminal, counters,
migration flags, etc.) and plain dict fields for less-structured caches.
"""

from __future__ import annotations

from pathlib import Path
from typing import TYPE_CHECKING, Any, ClassVar

from flow_sdk.fs_store import Record, RecordType

if TYPE_CHECKING:
    from flow_sdk.fs_store.scope import Scope


class ClaudeSettingsFsRecord(Record):
    """Root record representing the ~/.claude.json file itself.

    Captures scalar top-level fields and dict-valued caches that don't
    warrant their own record type.
    """

    _record_type: ClassVar[str] = RecordType.CLAUDE_SETTINGS

    def __init__(self, **kwargs: Any):
        if "type" not in kwargs:
            kwargs["type"] = RecordType.CLAUDE_SETTINGS
        super().__init__(**kwargs)
        from flow_sdk.fs_store.fs_ref import FSRef
        object.__setattr__(self, "_asset_ref", FSRef("/", read_only=True))

    @classmethod
    def _from_raw(cls, data: dict, source_file: str | Path) -> ClaudeSettingsFsRecord:
        """Create the root record from the full parsed ~/.claude.json."""
        rec = cls(
            # Identity & startup
            num_startups=data.get("numStartups", 0),
            install_method=data.get("installMethod", ""),
            auto_updates=data.get("autoUpdates", False),
            first_start_time=data.get("firstStartTime", ""),
            user_id=data.get("userID", ""),
            anonymous_id=data.get("anonymousId", ""),
            # Terminal setup
            apple_terminal_setup_in_progress=data.get("appleTerminalSetupInProgress", False),
            apple_terminal_backup_path=data.get("appleTerminalBackupPath", ""),
            option_as_meta_key_installed=data.get("optionAsMetaKeyInstalled", False),
            # Onboarding & hints
            has_completed_onboarding=data.get("hasCompletedOnboarding", False),
            last_onboarding_version=data.get("lastOnboardingVersion", ""),
            has_seen_tasks_hint=data.get("hasSeenTasksHint", False),
            has_seen_stash_hint=data.get("hasSeenStashHint", False),
            has_used_backslash_return=data.get("hasUsedBackslashReturn", False),
            has_acknowledged_cost_threshold=data.get("hasAcknowledgedCostThreshold", False),
            show_expanded_todos=data.get("showExpandedTodos", False),
            # Counters
            prompt_queue_use_count=data.get("promptQueueUseCount", 0),
            subscription_upsell_shown_count=data.get("subscriptionUpsellShownCount", 0),
            subscription_notice_count=data.get("subscriptionNoticeCount", 0),
            passes_upsell_seen_count=data.get("passesUpsellSeenCount", 0),
            # Subscription & billing
            recommended_subscription=data.get("recommendedSubscription", ""),
            has_available_subscription=data.get("hasAvailableSubscription", False),
            is_qualified_for_data_sharing=data.get("isQualifiedForDataSharing", False),
            # Migration flags
            sonnet45_migration_complete=data.get("sonnet45MigrationComplete", False),
            opus45_migration_complete=data.get("opus45MigrationComplete", False),
            opus_pro_migration_complete=data.get("opusProMigrationComplete", False),
            thinking_migration_complete=data.get("thinkingMigrationComplete", False),
            sonnet1m45_migration_complete=data.get("sonnet1m45MigrationComplete", False),
            # Release & changelog
            last_release_notes_seen=data.get("lastReleaseNotesSeen", ""),
            changelog_last_fetched=data.get("changelogLastFetched", 0),
            # IDE
            has_ide_onboarding_been_shown=data.get("hasIdeOnboardingBeenShown", {}),
            official_marketplace_auto_install_attempted=data.get("officialMarketplaceAutoInstallAttempted", False),
            official_marketplace_auto_installed=data.get("officialMarketplaceAutoInstalled", False),
            # Chrome extension
            claude_in_chrome_default_enabled=data.get("claudeInChromeDefaultEnabled", False),
            has_completed_claude_in_chrome_onboarding=data.get("hasCompletedClaudeInChromeOnboarding", False),
            cached_chrome_extension_installed=data.get("cachedChromeExtensionInstalled", False),
            # Misc flags
            has_opus_plan_default=data.get("hasOpusPlanDefault", False),
            auto_updates_protected_for_native=data.get("autoUpdatesProtectedForNative", False),
            has_visited_passes=data.get("hasVisitedPasses", False),
            passes_last_seen_remaining=data.get("passesLastSeenRemaining", 0),
            has_visited_extra_usage=data.get("hasVisitedExtraUsage", False),
            cached_extra_usage_disabled_reason=data.get("cachedExtraUsageDisabledReason", ""),
            penguin_mode_org_enabled=data.get("penguinModeOrgEnabled", False),
            show_spinner_tree=data.get("showSpinnerTree", False),
            effort_callout_dismissed=data.get("effortCalloutDismissed", False),
            last_plan_mode_use=data.get("lastPlanModeUse", 0),
            fallback_available_warning_threshold=data.get("fallbackAvailableWarningThreshold", 0.0),
            birthday_hat_animation_count=data.get("birthdayHatAnimationCount", 0),
            claude_code_first_token_date=data.get("claudeCodeFirstTokenDate", ""),
            passes_last_seen_campaign=data.get("passesLastSeenCampaign", ""),
            opus46_feed_seen_count=data.get("opus46FeedSeenCount", 0),
            # Custom API key responses
            custom_api_key_responses=data.get("customApiKeyResponses", {}),
            # Caches
            s1m_access_cache=data.get("s1mAccessCache", {}),
            feedback_survey_state=data.get("feedbackSurveyState", {}),
            passes_eligibility_cache=data.get("passesEligibilityCache", {}),
            grove_config_cache=data.get("groveConfigCache", {}),
            client_data_cache=data.get("clientDataCache", {}),
            has_shown_opus45_notice=data.get("hasShownOpus45Notice", {}),
            has_shown_opus46_notice=data.get("hasShownOpus46Notice", {}),
        )
        rec.id = "default"
        rec.source_file = str(source_file)
        return rec

    @classmethod
    def discover(cls, scope: Scope | None = None, **kwargs) -> list[ClaudeSettingsFsRecord]:
        """Extract settings records from ~/.claude.json."""
        from . import ClaudeSettingsRecordList
        rl = ClaudeSettingsRecordList.default()
        return [r for r in rl if isinstance(r, cls)]

    @classmethod
    def discover_one(cls, uid: str, scope: Scope | None = None, **kwargs) -> ClaudeSettingsFsRecord | None:
        """Find a specific settings record by uid."""
        for r in cls.discover(scope=scope):
            if r.id == uid:
                return r
        return None
