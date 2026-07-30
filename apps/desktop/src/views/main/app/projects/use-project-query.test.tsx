import { act, render, screen } from "@testing-library/react";
import { describe, expect, test } from "vitest";
import { useProjectQuery } from "./use-project-query";

describe("useProjectQuery", () => {
	test("does not expose retained data after the query identity changes", async () => {
		const next = Promise.withResolvers<string>();
		const firstQuery = () => Promise.resolve("First Runtime");
		const nextQuery = () => next.promise;
		const rendered = render(<QueryProbe queryKey="first" query={firstQuery} />);
		expect(await screen.findByText("First Runtime")).toBeVisible();

		rendered.rerender(<QueryProbe queryKey="next" query={nextQuery} />);
		expect(screen.queryByText("First Runtime")).not.toBeInTheDocument();
		expect(screen.getByText("Loading")).toBeVisible();

		next.resolve("Next Runtime");
		expect(await screen.findByText("Next Runtime")).toBeVisible();
	});

	test("ignores an obsolete captured reload without cancelling the current query", async () => {
		const next = Promise.withResolvers<string>();
		let capturedReload: (() => Promise<void>) | undefined;
		const rendered = render(
			<QueryProbe
				queryKey="first"
				query={() => Promise.resolve("First Runtime")}
				captureReload={(reload) => {
					capturedReload ??= reload;
				}}
			/>,
		);
		expect(await screen.findByText("First Runtime")).toBeVisible();

		rendered.rerender(
			<QueryProbe queryKey="next" query={() => next.promise} captureReload={() => {}} />,
		);
		expect(screen.getByText("Loading")).toBeVisible();
		await act(async () => {
			await capturedReload?.();
		});
		next.resolve("Next Runtime");

		expect(await screen.findByText("Next Runtime")).toBeVisible();
	});
});

function QueryProbe({
	queryKey,
	query,
	captureReload,
}: {
	queryKey: string;
	query(): Promise<string>;
	captureReload?(reload: () => Promise<void>): void;
}) {
	const result = useProjectQuery(queryKey, query, { retainData: true });
	captureReload?.(result.reload);
	if (result.isLoading && result.data === undefined) {
		return <span>Loading</span>;
	}
	return <span>{result.data}</span>;
}
