import { AppIcon, type AppIconName } from "@moshu/ui";
import { Spinner } from "@heroui/react";
import type { ReactNode } from "react";

export function Screen({ children }: { children: ReactNode }) {
	return <div className="flex h-full min-h-0 flex-col">{children}</div>;
}

export function ScreenHeader({
	title,
	subtitle,
	leading,
	trailing,
}: {
	title: string;
	subtitle?: string;
	leading?: ReactNode;
	trailing?: ReactNode;
}) {
	return (
		<header className="safe-top flex items-center gap-2 border-b border-[var(--line)] px-4 pb-3 pt-2">
			{leading}
			<div className="min-w-0 flex-1">
				<h1 className="truncate text-lg font-semibold text-[var(--text)]">{title}</h1>
				{subtitle ? (
					<p className="truncate text-xs text-[var(--text-muted)]">{subtitle}</p>
				) : null}
			</div>
			{trailing}
		</header>
	);
}

export function ScrollArea({ children }: { children: ReactNode }) {
	return <div className="app-scroll min-h-0 flex-1">{children}</div>;
}

export function CenteredState({
	icon,
	title,
	body,
	children,
}: {
	icon?: AppIconName;
	title: string;
	body?: string;
	children?: ReactNode;
}) {
	return (
		<div className="safe-x flex h-full flex-col items-center justify-center gap-4 px-8 text-center">
			{icon ? (
				<div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-[var(--surface-muted)] text-[var(--text-muted)]">
					<AppIcon name={icon} size={28} />
				</div>
			) : null}
			<div className="space-y-1">
				<h2 className="text-xl font-semibold text-[var(--text)]">{title}</h2>
				{body ? <p className="text-sm text-[var(--text-muted)]">{body}</p> : null}
			</div>
			{children ? <div className="flex w-full max-w-xs flex-col gap-2">{children}</div> : null}
		</div>
	);
}

export function LoadingState({ label }: { label: string }) {
	return (
		<div className="flex h-full flex-col items-center justify-center gap-3 text-[var(--text-muted)]">
			<Spinner aria-label={label} />
			<p className="text-sm">{label}</p>
		</div>
	);
}

export function EmptyRow({ label }: { label: string }) {
	return <p className="px-4 py-10 text-center text-sm text-[var(--text-muted)]">{label}</p>;
}
