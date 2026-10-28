# Test ids

Stable `data-testid` hooks for end-to-end tests. Prefer accessible names (roles and labels) where they exist; these ids cover elements without a unique accessible name. `<id>` marks a dynamic suffix (for example `case-action-<id>` is `case-action-hide`).

Generated from the source by `node scripts/gen-testids.mjs`; rerun it after adding or renaming an id.

## Shell and navigation

| Test id | Source |
|---|---|
| `avatar-menu` | `components/shell/avatar-menu.tsx` |
| `confirm-action` | `components/common/confirm-dialog.tsx` |
| `nav-admin` | `components/shell/avatar-menu.tsx` |
| `sign-out` | `components/shell/avatar-menu.tsx` |
| `theme-dark` | `components/shell/avatar-menu.tsx` |
| `theme-light` | `components/shell/avatar-menu.tsx` |
| `theme-system` | `components/shell/avatar-menu.tsx` |

## Sidebar

| Test id | Source |
|---|---|
| `account-menu` | `components/app/sidebar.tsx` |
| `nav-<id>` | `components/app/sidebar.tsx` |
| `sidebar-balance` | `components/app/sidebar.tsx` |
| `sign-out` | `components/app/sidebar.tsx` |

## Console

| Test id | Source |
|---|---|
| `create-key` | `components/console/keys.tsx` |
| `created-key-dialog` | `components/console/keys.tsx` |
| `created-key-secret` | `components/console/keys.tsx` |
| `getting-started` | `components/console/overview.tsx` |
| `key-dialog` | `components/console/keys.tsx` |
| `model-<id>` | `components/console/models.tsx` |
| `model-list` | `components/console/models.tsx` |
| `pg-input` | `components/console/playground.tsx` |
| `pg-send` | `components/console/playground.tsx` |
| `pg-stats` | `components/console/playground.tsx` |
| `pg-transcript` | `components/console/playground.tsx` |
| `save-key` | `components/console/keys.tsx` |
| `topup-form` | `components/console/billing.tsx` |
| `topup-preview` | `components/console/billing.tsx` |
| `topup-submit` | `components/console/billing.tsx` |
| `topup-waiting` | `components/console/billing.tsx` |

## Settings

| Test id | Source |
|---|---|
| `pref-theme` | `components/settings/settings-view.tsx` |
| `profile-name` | `components/settings/settings-view.tsx` |
| `profile-save` | `components/settings/settings-view.tsx` |
| `settings-appearance` | `components/settings/settings-view.tsx` |
| `settings-profile` | `components/settings/settings-view.tsx` |

## Sign up and sign in

| Test id | Source |
|---|---|
| `forgot-sent` | `components/auth/forgot-password.tsx` |
| `forgot-submit` | `components/auth/forgot-password.tsx` |
| `goodbye` | `components/auth/goodbye.tsx` |
| `login-submit` | `components/auth/login-form.tsx` |
| `recovery-code-input` | `components/auth/login-form.tsx` |
| `recovery-toggle` | `components/auth/login-form.tsx` |
| `reset-done` | `components/auth/reset-password.tsx` |
| `reset-submit` | `components/auth/reset-password.tsx` |
| `signup-check-email` | `components/auth/signup-form.tsx` |
| `signup-submit` | `components/auth/signup-form.tsx` |
| `totp-input` | `components/auth/login-form.tsx` |

## Account

| Test id | Source |
|---|---|
| `delete-account` | `components/account/privacy-section.tsx` |
| `delete-account-confirm` | `components/account/privacy-section.tsx` |
| `delete-account-dialog` | `components/account/privacy-section.tsx` |
| `delete-confirm-username` | `components/account/privacy-section.tsx` |
| `delete-password` | `components/account/privacy-section.tsx` |
| `delete-totp` | `components/account/privacy-section.tsx` |
| `export-data` | `components/account/privacy-section.tsx` |
| `password-save` | `components/account/security-section.tsx` |
| `recovery-codes` | `components/account/security-section.tsx` |
| `recovery-copy` | `components/account/security-section.tsx` |
| `recovery-done` | `components/account/security-section.tsx` |
| `recovery-download` | `components/account/security-section.tsx` |
| `recovery-saved` | `components/account/security-section.tsx` |
| `session-revoke` | `components/account/security-section.tsx` |
| `sessions-list` | `components/account/security-section.tsx` |
| `sessions-sign-out-all` | `components/account/security-section.tsx` |
| `totp-disable` | `components/account/security-section.tsx` |
| `totp-enable` | `components/account/security-section.tsx` |
| `totp-qr` | `components/account/security-section.tsx` |
| `totp-regenerate` | `components/account/security-section.tsx` |
| `totp-secret` | `components/account/security-section.tsx` |
| `totp-start` | `components/account/security-section.tsx` |

## Admin

| Test id | Source |
|---|---|
| `<id>-clear` | `components/admin/pages/user-sheet.tsx` |
| `<id>-input` | `components/admin/pages/user-sheet.tsx` |
| `<id>-save` | `components/admin/pages/user-sheet.tsx` |
| `admin-back-to-chat` | `components/admin/shell/admin-shell.tsx` |
| `admin-forbidden` | `components/admin/shell/forbidden.tsx` |
| `admin-menu` | `components/admin/shell/admin-shell.tsx` |
| `admin-nav` | `components/admin/shell/admin-shell.tsx` |
| `admin-nav-<id>` | `components/admin/shell/admin-shell.tsx` |
| `admin-product-name` | `components/admin/shell/admin-shell.tsx` |
| `admin-sidebar` | `components/admin/shell/admin-shell.tsx` |
| `admin-sidebar-toggle` | `components/admin/shell/admin-shell.tsx` |
| `audit-data` | `components/admin/pages/audit.tsx` |
| `audit-expand` | `components/admin/pages/audit.tsx` |
| `audit-list` | `components/admin/pages/audit.tsx` |
| `audit-more` | `components/admin/pages/audit.tsx` |
| `audit-row-<id>` | `components/admin/pages/audit.tsx` |
| `credential-<id>` | `components/admin/pages/providers.tsx` |
| `credential-add` | `components/admin/pages/providers.tsx` |
| `credential-delete-<id>` | `components/admin/pages/providers.tsx` |
| `credential-enabled-<id>` | `components/admin/pages/providers.tsx` |
| `credential-form` | `components/admin/pages/providers.tsx` |
| `credential-label` | `components/admin/pages/providers.tsx` |
| `credential-secret` | `components/admin/pages/providers.tsx` |
| `credentials-key-missing` | `components/admin/pages/providers.tsx` |
| `credentials-list` | `components/admin/pages/providers.tsx` |
| `credit-amount` | `components/admin/pages/user-sheet.tsx` |
| `credit-form` | `components/admin/pages/user-sheet.tsx` |
| `credit-reason` | `components/admin/pages/user-sheet.tsx` |
| `credit-save` | `components/admin/pages/user-sheet.tsx` |
| `credit-type` | `components/admin/pages/user-sheet.tsx` |
| `health-close-<id>` | `components/admin/pages/health.tsx` |
| `health-open-<id>` | `components/admin/pages/health.tsx` |
| `health-refresh` | `components/admin/pages/health.tsx` |
| `health-route-<id>` | `components/admin/pages/health.tsx` |
| `health-summary` | `components/admin/pages/health.tsx` |
| `integrations-key-warning` | `components/admin/pages/settings.tsx` |
| `model-add` | `components/admin/pages/models.tsx` |
| `model-aliases` | `components/admin/pages/models.tsx` |
| `model-context` | `components/admin/pages/models.tsx` |
| `model-delete` | `components/admin/pages/models.tsx` |
| `model-description` | `components/admin/pages/models.tsx` |
| `model-dialog` | `components/admin/pages/models.tsx` |
| `model-edit` | `components/admin/pages/models.tsx` |
| `model-enabled-<id>` | `components/admin/pages/models.tsx` |
| `model-id` | `components/admin/pages/models.tsx` |
| `model-kind` | `components/admin/pages/models.tsx` |
| `model-margin` | `components/admin/pages/models.tsx` |
| `model-max-output` | `components/admin/pages/models.tsx` |
| `model-menu-<id>` | `components/admin/pages/models.tsx` |
| `model-name` | `components/admin/pages/models.tsx` |
| `model-owner` | `components/admin/pages/models.tsx` |
| `model-price` | `components/admin/pages/models.tsx` |
| `model-save` | `components/admin/pages/models.tsx` |
| `model-sheet-enabled` | `components/admin/pages/models.tsx` |
| `model-sort` | `components/admin/pages/models.tsx` |
| `model-unpriced-dialog` | `components/admin/pages/models.tsx` |
| `model-unpriced-note` | `components/admin/pages/models.tsx` |
| `probe-marks` | `components/admin/pages/health.tsx` |
| `promo-active-<id>` | `components/admin/pages/billing.tsx` |
| `promo-add` | `components/admin/pages/billing.tsx` |
| `promo-amount` | `components/admin/pages/billing.tsx` |
| `promo-code` | `components/admin/pages/billing.tsx` |
| `promo-dialog` | `components/admin/pages/billing.tsx` |
| `promo-expires` | `components/admin/pages/billing.tsx` |
| `promo-max` | `components/admin/pages/billing.tsx` |
| `promo-save` | `components/admin/pages/billing.tsx` |
| `provider-add` | `components/admin/pages/providers.tsx` |
| `provider-dialog` | `components/admin/pages/providers.tsx` |
| `provider-edit` | `components/admin/pages/providers.tsx` |
| `provider-enabled` | `components/admin/pages/providers.tsx` |
| `provider-kind` | `components/admin/pages/providers.tsx` |
| `provider-menu-<id>` | `components/admin/pages/providers.tsx` |
| `provider-name` | `components/admin/pages/providers.tsx` |
| `provider-save` | `components/admin/pages/providers.tsx` |
| `provider-slug` | `components/admin/pages/providers.tsx` |
| `provider-url` | `components/admin/pages/providers.tsx` |
| `reason-confirm` | `components/admin/shell/reason-dialog.tsx` |
| `reason-days` | `components/admin/shell/reason-dialog.tsx` |
| `reason-input` | `components/admin/shell/reason-dialog.tsx` |
| `reason-typed` | `components/admin/shell/reason-dialog.tsx` |
| `route-<id>` | `components/admin/pages/models.tsx` |
| `route-add` | `components/admin/pages/models.tsx` |
| `route-cost-<id>` | `components/admin/pages/models.tsx` |
| `route-delete-<id>` | `components/admin/pages/models.tsx` |
| `route-dialog` | `components/admin/pages/models.tsx` |
| `route-edit-<id>` | `components/admin/pages/models.tsx` |
| `route-priority` | `components/admin/pages/models.tsx` |
| `route-provider` | `components/admin/pages/models.tsx` |
| `route-save` | `components/admin/pages/models.tsx` |
| `route-test-<id>` | `components/admin/pages/models.tsx` |
| `route-test-result-<id>` | `components/admin/pages/models.tsx` |
| `route-timeout` | `components/admin/pages/models.tsx` |
| `route-upstream` | `components/admin/pages/models.tsx` |
| `routes-list` | `components/admin/pages/models.tsx` |
| `settings-app-name` | `components/admin/pages/settings.tsx` |
| `settings-discard` | `components/admin/pages/settings.tsx` |
| `settings-domain-add` | `components/admin/pages/settings.tsx` |
| `settings-domain-input` | `components/admin/pages/settings.tsx` |
| `settings-domains` | `components/admin/pages/settings.tsx` |
| `settings-form` | `components/admin/pages/settings.tsx` |
| `settings-gateway-url` | `components/admin/pages/settings.tsx` |
| `settings-min-version` | `components/admin/pages/settings.tsx` |
| `settings-registration` | `components/admin/pages/settings.tsx` |
| `settings-save` | `components/admin/pages/settings.tsx` |
| `settings-save-bar` | `components/admin/pages/settings.tsx` |
| `settings-support-email` | `components/admin/pages/settings.tsx` |
| `settings-tagline` | `components/admin/pages/settings.tsx` |
| `settings-tax-label` | `components/admin/pages/settings.tsx` |
| `tier-add` | `components/admin/pages/tiers.tsx` |
| `tier-concurrency` | `components/admin/pages/tiers.tsx` |
| `tier-default` | `components/admin/pages/tiers.tsx` |
| `tier-default-marker` | `components/admin/pages/tiers.tsx` |
| `tier-dialog` | `components/admin/pages/tiers.tsx` |
| `tier-menu-<id>` | `components/admin/pages/tiers.tsx` |
| `tier-name` | `components/admin/pages/tiers.tsx` |
| `tier-rpm` | `components/admin/pages/tiers.tsx` |
| `tier-save` | `components/admin/pages/tiers.tsx` |
| `tier-tpm` | `components/admin/pages/tiers.tsx` |
| `topup-refund-<id>` | `components/admin/pages/billing.tsx` |
| `user-balance` | `components/admin/pages/user-sheet.tsx` |
| `user-ban` | `components/admin/pages/user-sheet.tsx` |
| `user-erase` | `components/admin/pages/user-sheet.tsx` |
| `user-key-<id>` | `components/admin/pages/user-sheet.tsx` |
| `user-keys` | `components/admin/pages/user-sheet.tsx` |
| `user-make-admin` | `components/admin/pages/user-sheet.tsx` |
| `user-remove-admin` | `components/admin/pages/user-sheet.tsx` |
| `user-suspend` | `components/admin/pages/user-sheet.tsx` |
| `user-tier` | `components/admin/pages/user-sheet.tsx` |
| `user-topups-link` | `components/admin/pages/user-sheet.tsx` |
| `user-unban` | `components/admin/pages/user-sheet.tsx` |
| `user-unsuspend` | `components/admin/pages/user-sheet.tsx` |
| `users-role` | `components/admin/pages/users.tsx` |
| `users-tier` | `components/admin/pages/users.tsx` |
