import { useCallback, useEffect, useRef, useState } from "react";

interface ProjectQueryState<T> {
	data: T | undefined;
	error: Error | undefined;
	isLoading: boolean;
	reload(): Promise<void>;
}

interface ProjectQuerySnapshot<T> {
	key: string;
	data: T | undefined;
	error: Error | undefined;
	isLoading: boolean;
}

export function useProjectQuery<T>(
	key: string,
	query: () => Promise<T>,
	options: { enabled?: boolean; retainData?: boolean } = {},
): ProjectQueryState<T> {
	const { enabled = true, retainData = false } = options;
	const [snapshot, setSnapshot] = useState<ProjectQuerySnapshot<T>>({
		key,
		data: undefined,
		error: undefined,
		isLoading: enabled,
	});
	const requestRef = useRef(0);
	const currentKeyRef = useRef(key);
	currentKeyRef.current = key;

	const reload = useCallback(async () => {
		if (currentKeyRef.current !== key) {
			return;
		}
		const requestId = requestRef.current + 1;
		requestRef.current = requestId;
		if (!enabled) {
			if (currentKeyRef.current !== key) {
				return;
			}
			setSnapshot({ key, data: undefined, error: undefined, isLoading: false });
			return;
		}
		setSnapshot((current) => ({
			key,
			data: retainData && current.key === key ? current.data : undefined,
			error: undefined,
			isLoading: true,
		}));
		try {
			const output = await query();
			if (currentKeyRef.current === key && requestRef.current === requestId) {
				setSnapshot({ key, data: output, error: undefined, isLoading: false });
			}
		} catch (caught) {
			if (currentKeyRef.current === key && requestRef.current === requestId) {
				setSnapshot((current) => ({
					key,
					data: current.key === key ? current.data : undefined,
					error: caught instanceof Error ? caught : new Error("Project request failed."),
					isLoading: false,
				}));
			}
		}
	}, [enabled, key, query, retainData]);

	useEffect(() => {
		void reload();
		return () => {
			requestRef.current += 1;
		};
	}, [reload]);

	if (snapshot.key !== key) {
		return {
			data: undefined,
			error: undefined,
			isLoading: enabled,
			reload,
		};
	}
	return { data: snapshot.data, error: snapshot.error, isLoading: snapshot.isLoading, reload };
}
