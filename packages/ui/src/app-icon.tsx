import {
	Bell,
	CircleCheck,
	Comment,
	FaceRobot,
	Folder,
	Gear,
	ListUl,
	Picture,
	Plus,
} from "@gravity-ui/icons";
import type { ComponentType, SVGProps } from "react";

const icons = {
	agents: FaceRobot,
	canvas: Picture,
	chat: Comment,
	check: CircleCheck,
	notifications: Bell,
	plus: Plus,
	projects: Folder,
	settings: Gear,
	tasks: ListUl,
} satisfies Record<string, ComponentType<SVGProps<SVGSVGElement>>>;

export type AppIconName = keyof typeof icons;

export interface AppIconProps extends Omit<SVGProps<SVGSVGElement>, "height" | "width"> {
	name: AppIconName;
	size?: number;
	label?: string;
}

export function AppIcon({ name, size = 18, label, ...props }: AppIconProps) {
	const Icon = icons[name];

	return (
		<Icon
			{...props}
			width={size}
			height={size}
			focusable="false"
			role={label ? "img" : undefined}
			aria-hidden={label ? undefined : true}
			aria-label={label}
		/>
	);
}
