import { AlertDialog, Button } from "@heroui/react";

export interface ConfirmationDialogProps {
	isOpen: boolean;
	isPending: boolean;
	isTriggerDisabled?: boolean;
	triggerLabel: string;
	triggerClassName: string;
	title: string;
	description: string;
	cancelLabel: string;
	confirmLabel: string;
	pendingLabel: string;
	onOpenChange(isOpen: boolean): void;
	onConfirm(): Promise<void>;
}

export function ConfirmationDialog({
	isOpen,
	isPending,
	isTriggerDisabled = false,
	triggerLabel,
	triggerClassName,
	title,
	description,
	cancelLabel,
	confirmLabel,
	pendingLabel,
	onOpenChange,
	onConfirm,
}: ConfirmationDialogProps) {
	const handleOpenChange = (nextIsOpen: boolean) => {
		if ((nextIsOpen && isTriggerDisabled) || (!nextIsOpen && isPending)) {
			return;
		}
		onOpenChange(nextIsOpen);
	};

	return (
		<AlertDialog isOpen={isOpen} onOpenChange={handleOpenChange}>
			<AlertDialog.Trigger
				className={triggerClassName}
				aria-disabled={isTriggerDisabled}
				data-disabled={isTriggerDisabled}
				tabIndex={isTriggerDisabled ? -1 : 0}
			>
				{triggerLabel}
			</AlertDialog.Trigger>
			<AlertDialog.Backdrop
				className="confirmation-dialog__backdrop"
				isDismissable={false}
				isKeyboardDismissDisabled={isPending}
			>
				<AlertDialog.Container
					className="confirmation-dialog__container"
					placement="center"
					size="sm"
				>
					<AlertDialog.Dialog className="confirmation-dialog">
						<AlertDialog.Header className="confirmation-dialog__header">
							<AlertDialog.Icon status="danger" />
							<AlertDialog.Heading>{title}</AlertDialog.Heading>
						</AlertDialog.Header>
						<AlertDialog.Body className="confirmation-dialog__body">
							<p>{description}</p>
						</AlertDialog.Body>
						<AlertDialog.Footer className="confirmation-dialog__footer">
							<Button
								className="chat-button"
								isDisabled={isPending}
								onPress={() => onOpenChange(false)}
							>
								{cancelLabel}
							</Button>
							<Button
								className="chat-button chat-button--danger"
								isDisabled={isPending}
								onPress={() => void onConfirm()}
							>
								{isPending ? pendingLabel : confirmLabel}
							</Button>
						</AlertDialog.Footer>
					</AlertDialog.Dialog>
				</AlertDialog.Container>
			</AlertDialog.Backdrop>
		</AlertDialog>
	);
}
