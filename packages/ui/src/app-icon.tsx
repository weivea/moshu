import {
	ArrowsExpand,
	Bell,
	Calendar,
	ChevronLeft,
	ChevronRight,
	ChevronsCollapseToLine,
	CircleCheck,
	Comment,
	Ellipsis,
	FaceRobot,
	FileText,
	Folder,
	Funnel,
	Gear,
	Globe,
	House,
	LayoutColumns,
	LayoutSideContentLeft,
	LayoutSideContentRight,
	ListCheck,
	ListUl,
	Magnifier,
	Moon,
	PaperPlane,
	Person,
	Picture,
	Plus,
	Smartphone,
	Sun,
	Terminal,
} from "@gravity-ui/icons";
import type { ComponentType, SVGProps } from "react";

const icons = {
	agents: FaceRobot,
	automations: Calendar,
	back: ChevronLeft,
	canvas: Picture,
	chat: Comment,
	check: CircleCheck,
	changes: FileText,
	collapse: ChevronsCollapseToLine,
	expand: ArrowsExpand,
	filter: Funnel,
	forward: ChevronRight,
	globe: Globe,
	home: House,
	menu: Ellipsis,
	moon: Moon,
	myWork: ListCheck,
	notifications: Bell,
	panelLeft: LayoutSideContentLeft,
	panelLeftOpen: LayoutColumns,
	panelRight: LayoutSideContentRight,
	panelRightOpen: LayoutColumns,
	person: Person,
	plus: Plus,
	projects: Folder,
	search: Magnifier,
	send: PaperPlane,
	settings: Gear,
	smartphone: Smartphone,
	sun: Sun,
	tasks: ListUl,
	terminal: Terminal,
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
