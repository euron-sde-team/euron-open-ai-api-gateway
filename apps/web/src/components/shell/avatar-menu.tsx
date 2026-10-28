"use client";

import Link from "next/link";
import { LayoutDashboard, LogOut, MessageSquare, Monitor, Moon, Settings, Sun } from "lucide-react";
import {
  Avatar,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@open-gateway/ui";
import { useAuth, useMe } from "@/lib/auth";
import { useTheme, type ThemePref } from "@/lib/stores/theme";

export function AvatarMenu() {
  const me = useMe();
  const { logout } = useAuth();
  const { pref, setPref } = useTheme();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button type="button" data-testid="avatar-menu" className="rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2">
          <span className="sr-only">Account menu for {me.displayName}</span>
          <span aria-hidden>
            <Avatar name={me.displayName} seed={me.id} size="sm" />
          </span>
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent className="w-64">
        <div className="px-3 pb-2 pt-3">
          <p className="truncate font-semibold text-foreground">{me.displayName}</p>
          <p className="truncate text-[13px] text-muted-foreground">{me.email}</p>
        </div>
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild>
          <Link href="/">
            <MessageSquare /> Chats
          </Link>
        </DropdownMenuItem>
        <DropdownMenuItem asChild>
          <Link href="/settings">
            <Settings /> Settings
          </Link>
        </DropdownMenuItem>
        {me.canOpenAdmin ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem asChild>
              <Link href="/admin" data-testid="nav-admin">
                <LayoutDashboard /> Admin
              </Link>
            </DropdownMenuItem>
          </>
        ) : null}
        <DropdownMenuSeparator />
        <DropdownMenuLabel>Appearance</DropdownMenuLabel>
        <DropdownMenuRadioGroup value={pref} onValueChange={(v) => setPref(v as ThemePref)}>
          <DropdownMenuRadioItem value="system" data-testid="theme-system">
            <Monitor /> Match device
          </DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="light" data-testid="theme-light">
            <Sun /> Light
          </DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="dark" data-testid="theme-dark">
            <Moon /> Dark
          </DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => void logout()} data-testid="sign-out">
          <LogOut /> Sign out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
