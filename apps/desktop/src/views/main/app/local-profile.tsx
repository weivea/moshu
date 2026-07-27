import { createContext, type ReactNode, useContext, useMemo, useState } from "react";

const profileStorageKey = "moshu.localProfile.v1";

interface StoredProfile {
	username: string;
}

interface LocalProfileContextValue {
	username: string | null;
	setUsername(username: string): void;
}

const LocalProfileContext = createContext<LocalProfileContextValue | undefined>(undefined);

export function LocalProfileProvider({ children }: { children: ReactNode }) {
	const [username, setUsernameState] = useState<string | null>(readStoredUsername);
	const value = useMemo<LocalProfileContextValue>(
		() => ({
			username,
			setUsername: (nextUsername) => {
				const normalizedUsername = nextUsername.trim();
				if (normalizedUsername.length === 0) {
					throw new Error("Local profile username cannot be empty.");
				}
				localStorage.setItem(
					profileStorageKey,
					JSON.stringify({ username: normalizedUsername } satisfies StoredProfile),
				);
				setUsernameState(normalizedUsername);
			},
		}),
		[username],
	);

	return <LocalProfileContext.Provider value={value}>{children}</LocalProfileContext.Provider>;
}

export function useLocalProfile(): LocalProfileContextValue {
	const context = useContext(LocalProfileContext);
	if (!context) {
		throw new Error("useLocalProfile must be used inside LocalProfileProvider.");
	}
	return context;
}

function readStoredUsername(): string | null {
	const storedValue = localStorage.getItem(profileStorageKey);
	if (storedValue === null) {
		return null;
	}

	try {
		const parsedValue: unknown = JSON.parse(storedValue);
		if (
			typeof parsedValue === "object" &&
			parsedValue !== null &&
			"username" in parsedValue &&
			typeof parsedValue.username === "string" &&
			parsedValue.username.trim().length > 0
		) {
			return parsedValue.username.trim();
		}
	} catch (error) {
		console.warn("Ignoring invalid local profile data.", error);
		localStorage.removeItem(profileStorageKey);
		return null;
	}

	console.warn("Ignoring local profile data with an invalid shape.");
	localStorage.removeItem(profileStorageKey);
	return null;
}
