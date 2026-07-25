import { AppIcon, type AppIconName } from "@moshu/ui";

export interface EmptyStateProps {
	icon: AppIconName;
	title: string;
	description: string;
}

export function EmptyState({ icon, title, description }: EmptyStateProps) {
	return (
		<section className="empty-state">
			<span className="empty-state__icon">
				<AppIcon name={icon} size={24} />
			</span>
			<h1>{title}</h1>
			<p>{description}</p>
		</section>
	);
}
