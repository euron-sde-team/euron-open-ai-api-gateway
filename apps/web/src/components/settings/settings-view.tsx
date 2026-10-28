"use client";

/**
 * Settings: how the console looks, and the account (profile, security, your data).
 * API keys, billing and usage have their own pages.
 */
import { useEffect, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Button, Input, NativeSelect, toast } from "@open-gateway/ui";
import { PrivacySection } from "@/components/account/privacy-section";
import { SecuritySection } from "@/components/account/security-section";
import { PageBar } from "@/components/app/app-shell";
import { UnderlineTabs } from "@/components/common/underline-tabs";
import { api } from "@/lib/api";
import { useAuth, useMe } from "@/lib/auth";
import { errorMessage } from "@/lib/errors";
import { useTheme, type ThemePref } from "@/lib/stores/theme";

type Tab = "account" | "appearance";
const TABS: { value: Tab; label: string }[] = [
  { value: "account", label: "Account" },
  { value: "appearance", label: "Appearance" },
];

function Row({ title, description, htmlFor, children, testId }: { title: string; description?: React.ReactNode; htmlFor?: string; children: React.ReactNode; testId?: string }) {
  return (
    <div className="flex flex-col gap-3 border-b border-border py-5 sm:flex-row sm:items-center sm:justify-between" data-testid={testId}>
      <div className="min-w-0">
        {htmlFor ? (
          <label htmlFor={htmlFor} className="text-[14.5px] font-medium">
            {title}
          </label>
        ) : (
          <p className="text-[14.5px] font-medium">{title}</p>
        )}
        {description ? <p className="mt-0.5 max-w-md text-[13.5px] text-muted-foreground">{description}</p> : null}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

/** Saves a preference change, showing it at once and rolling back if the server says no. */
// ─── Appearance ─────────────────────────────────────────────────────────────

function Appearance() {
  const { pref, setPref } = useTheme();
  return (
    <div data-testid="settings-appearance">
      <Row title="Theme" htmlFor="pref-theme" description="System follows your device's light or dark setting. Saved on this device only.">
        <NativeSelect id="pref-theme" value={pref} onChange={(e) => setPref(e.target.value as ThemePref)} className="w-40" data-testid="pref-theme">
          <option value="system">System</option>
          <option value="light">Light</option>
          <option value="dark">Dark</option>
        </NativeSelect>
      </Row>
    </div>
  );
}

// ─── Account ────────────────────────────────────────────────────────────────

function Profile() {
  const me = useMe();
  const { setUser } = useAuth();
  const [name, setName] = useState(me.displayName);
  useEffect(() => setName(me.displayName), [me.displayName]);
  const save = useMutation({
    mutationFn: () => api().users.updateMe({ displayName: name.trim() }),
    meta: { silent: true },
    onSuccess: (u) => {
      setUser(u);
      toast.success({ title: "Name saved" });
    },
    onError: (e) => toast.error({ title: errorMessage(e) }),
  });
  const dirty = !!name.trim() && name.trim() !== me.displayName;
  return (
    <form
      className="border-b border-border pb-8"
      onSubmit={(e) => {
        e.preventDefault();
        if (dirty) save.mutate();
      }}
      data-testid="settings-profile"
    >
      <h2 className="font-display text-[20px] font-semibold tracking-[-0.01em]">Profile</h2>
      <p className="mt-1 max-w-[620px] text-[14px] text-muted-foreground">
        Your name appears on receipts and to administrators. You sign in as <span className="text-foreground">{me.email}</span>.
      </p>
      <label htmlFor="profile-name" className="mt-5 block text-[13px] font-medium">
        Display name
      </label>
      <div className="mt-1.5 flex gap-2">
        <Input id="profile-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={80} autoComplete="name" className="max-w-xs" data-testid="profile-name" />
        <Button type="submit" variant="outline" disabled={!dirty} loading={save.isPending} data-testid="profile-save">
          Save
        </Button>
      </div>
    </form>
  );
}

export function SettingsView() {
  const [tab, setTab] = useState<Tab>("account");
  return (
    <div>
      <PageBar />
      <div className="mx-auto w-full max-w-[860px] px-4 pb-20 sm:px-6">
        <h1 className="font-display text-[30px] font-semibold tracking-[-0.02em]">Settings</h1>
        <UnderlineTabs tabs={TABS} value={tab} onChange={setTab} label="Settings sections" className="mt-6" />
        <div role="tabpanel" aria-label={TABS.find((t) => t.value === tab)?.label} className="mt-2">
          {tab === "appearance" ? <Appearance /> : null}
          {tab === "account" ? (
            <div className="pt-6">
              <Profile />
              <div className="pt-8">
                <SecuritySection />
              </div>
              <div className="pt-10">
                <PrivacySection />
              </div>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
