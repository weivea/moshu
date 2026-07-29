import { dlopen, FFIType, ptr, type Pointer } from "bun:ffi";

const jobObjectExtendedLimitInformation = 9;
const jobObjectLimitKillOnJobClose = 0x00002000;
const processTerminate = 0x0001;
const processSetQuota = 0x0100;
const extendedLimitInformationBytes = 144;

function loadKernel32() {
	return dlopen("kernel32.dll", {
		CreateJobObjectW: {
			args: [FFIType.ptr, FFIType.ptr],
			returns: FFIType.ptr,
		},
		SetInformationJobObject: {
			args: [FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.u32],
			returns: FFIType.bool,
		},
		OpenProcess: {
			args: [FFIType.u32, FFIType.bool, FFIType.u32],
			returns: FFIType.ptr,
		},
		AssignProcessToJobObject: {
			args: [FFIType.ptr, FFIType.ptr],
			returns: FFIType.bool,
		},
		TerminateJobObject: {
			args: [FFIType.ptr, FFIType.u32],
			returns: FFIType.bool,
		},
		CloseHandle: {
			args: [FFIType.ptr],
			returns: FFIType.bool,
		},
		GetLastError: {
			args: [],
			returns: FFIType.u32,
		},
	});
}

let kernel32: ReturnType<typeof loadKernel32> | undefined;

function getKernel32(): ReturnType<typeof loadKernel32> {
	kernel32 ??= loadKernel32();
	return kernel32;
}

function requireHandle(handle: Pointer | null, operation: string): Pointer {
	if (!handle) {
		throw new Error(
			`${operation} failed with Windows error ${getKernel32().symbols.GetLastError()}`,
		);
	}
	return handle;
}

export interface WindowsProcessJob {
	terminate(): void;
	close(): void;
}

export function assignProcessToWindowsJob(pid: number): WindowsProcessJob {
	const library = getKernel32();
	const job = requireHandle(library.symbols.CreateJobObjectW(null, null), "CreateJobObjectW");
	const information = Buffer.alloc(extendedLimitInformationBytes);
	information.writeUInt32LE(jobObjectLimitKillOnJobClose, 16);
	if (
		!library.symbols.SetInformationJobObject(
			job,
			jobObjectExtendedLimitInformation,
			ptr(information),
			information.byteLength,
		)
	) {
		const error = library.symbols.GetLastError();
		library.symbols.CloseHandle(job);
		throw new Error(`SetInformationJobObject failed with Windows error ${error}`);
	}

	let processHandle: Pointer | undefined;
	try {
		processHandle = requireHandle(
			library.symbols.OpenProcess(processTerminate | processSetQuota, false, pid),
			"OpenProcess",
		);
		if (!library.symbols.AssignProcessToJobObject(job, processHandle)) {
			throw new Error(
				`AssignProcessToJobObject failed with Windows error ${library.symbols.GetLastError()}`,
			);
		}
	} catch (error) {
		library.symbols.CloseHandle(job);
		throw error;
	} finally {
		if (processHandle) {
			library.symbols.CloseHandle(processHandle);
		}
	}

	let closed = false;
	return {
		terminate(): void {
			if (!closed && !library.symbols.TerminateJobObject(job, 1)) {
				throw new Error(
					`TerminateJobObject failed with Windows error ${library.symbols.GetLastError()}`,
				);
			}
		},
		close(): void {
			if (closed) {
				return;
			}
			closed = true;
			if (!library.symbols.CloseHandle(job)) {
				throw new Error(
					`CloseHandle(job) failed with Windows error ${library.symbols.GetLastError()}`,
				);
			}
		},
	};
}
