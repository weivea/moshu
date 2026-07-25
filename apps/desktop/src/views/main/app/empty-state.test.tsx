import { render, screen } from "@testing-library/react";
import { describe, expect, test } from "vitest";
import { EmptyState } from "./empty-state";

describe("EmptyState", () => {
	test("renders an accessible route placeholder", () => {
		render(
			<EmptyState
				icon="projects"
				title="Projects"
				description="Project management is ready for implementation."
			/>,
		);

		expect(screen.getByRole("heading", { name: "Projects" })).toBeInTheDocument();
		expect(screen.getByText("Project management is ready for implementation.")).toBeVisible();
	});
});
