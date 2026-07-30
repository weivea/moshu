import { z } from "zod";
import { isoDateTimeSchema, uuidV7Schema } from "./contract-primitives";
import { runtimeBoxIdSchema } from "./runtime-box";

export const projectNameSchema = z.string().trim().min(1).max(128);
export const projectPathSchema = z.string().trim().min(1).max(4_096);
export const projectGitBranchSchema = z.string().trim().min(1).max(512);
export const projectPathRevisionSchema = z.int().positive().safe();
export const projectPathStatusValues = ["unknown", "available", "unavailable"] as const;
export const projectPathStatusSchema = z.enum(projectPathStatusValues);
export const projectPathIssueCodeValues = [
	"not_absolute",
	"not_found",
	"not_directory",
	"permission_denied",
	"canonical_path_changed",
	"unknown",
] as const;
export const projectPathIssueCodeSchema = z.enum(projectPathIssueCodeValues);
export const projectRootAgentsIssueCodeSchema = z.enum([
	"not_regular_file",
	"permission_denied",
	"too_large",
	"invalid_utf8",
	"unknown",
]);
export const maxProjectRootAgentsBytes = 64 * 1_024;
const projectRootAgentsBodySchema = z
	.string()
	.max(maxProjectRootAgentsBytes)
	.refine((value) => new TextEncoder().encode(value).byteLength <= maxProjectRootAgentsBytes, {
		message: `Root AGENTS.md must not exceed ${maxProjectRootAgentsBytes} UTF-8 bytes.`,
	});
export const projectRootAgentsStatusSchema = z.discriminatedUnion("status", [
	z
		.object({
			status: z.literal("available"),
			sizeBytes: z.int().nonnegative().safe(),
			modifiedAt: isoDateTimeSchema,
		})
		.strict(),
	z.object({ status: z.literal("missing") }).strict(),
	z
		.object({
			status: z.literal("warning"),
			issueCode: projectRootAgentsIssueCodeSchema,
		})
		.strict(),
]);
export const projectPreviewConfirmationTokenSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const projectPathHealthSchema = z
	.object({
		status: projectPathStatusSchema,
		checkedAt: isoDateTimeSchema.optional(),
		issueCode: projectPathIssueCodeSchema.optional(),
	})
	.strict()
	.superRefine((value, context) => {
		if ((value.status === "unavailable") !== (value.issueCode !== undefined)) {
			context.addIssue({
				code: "custom",
				path: ["issueCode"],
				message: "Unavailable Project paths require exactly one stable issue code.",
			});
		}
	});
export const projectSessionCountsSchema = z
	.object({
		active: z.int().nonnegative().safe(),
		archived: z.int().nonnegative().safe(),
		total: z.int().nonnegative().safe(),
	})
	.strict()
	.refine((value) => value.active + value.archived === value.total, {
		message: "Project Session counts must add up to the total.",
	});

export const projectSchema = z
	.object({
		schemaVersion: z.literal(1),
		id: uuidV7Schema,
		runtimeBoxId: runtimeBoxIdSchema,
		name: projectNameSchema,
		path: projectPathSchema,
		pathRevision: projectPathRevisionSchema,
		pathStatus: projectPathStatusSchema,
		pathCheckedAt: isoDateTimeSchema.optional(),
		pathIssueCode: projectPathIssueCodeSchema.optional(),
		gitRootPath: projectPathSchema.optional(),
		gitBranch: projectGitBranchSchema.optional(),
		createdAt: isoDateTimeSchema,
		updatedAt: isoDateTimeSchema,
		archivedAt: isoDateTimeSchema.optional(),
		deletionRequestedAt: isoDateTimeSchema.optional(),
	})
	.strict()
	.superRefine((value, context) => {
		if (value.pathStatus === "unavailable" && value.pathIssueCode === undefined) {
			context.addIssue({
				code: "custom",
				path: ["pathIssueCode"],
				message: "Unavailable Project paths require a stable issue code.",
			});
		}
		if (value.pathStatus !== "unavailable" && value.pathIssueCode !== undefined) {
			context.addIssue({
				code: "custom",
				path: ["pathIssueCode"],
				message: "Only unavailable Project paths may include an issue code.",
			});
		}
	});

export const projectPathPreviewSchema = z
	.object({
		schemaVersion: z.literal(1),
		runtimeBoxId: runtimeBoxIdSchema,
		runtimeBoxDisplayName: z.string().trim().min(1).max(128),
		runtimeBoxPlatform: z.enum(["darwin", "win32", "linux"]),
		inputPath: projectPathSchema,
		normalizedPath: projectPathSchema,
		displayName: projectNameSchema,
		gitRootPath: projectPathSchema.optional(),
		gitBranch: projectGitBranchSchema.optional(),
		rootAgents: projectRootAgentsStatusSchema,
		confirmationToken: projectPreviewConfirmationTokenSchema,
	})
	.strict();

export const previewProjectPathInputSchema = z
	.object({
		runtimeBoxId: runtimeBoxIdSchema.optional(),
		path: projectPathSchema,
	})
	.strict();
export const previewProjectPathOutputSchema = z
	.object({ preview: projectPathPreviewSchema })
	.strict();

export const checkProjectPathInputSchema = z.object({ projectId: uuidV7Schema }).strict();
export const checkProjectPathOutputSchema = z.object({ project: projectSchema }).strict();

export const previewProjectRelinkInputSchema = z
	.object({ projectId: uuidV7Schema, path: projectPathSchema })
	.strict();
export const previewProjectRelinkOutputSchema = previewProjectPathOutputSchema;
export const relinkProjectInputSchema = z
	.object({
		projectId: uuidV7Schema,
		path: projectPathSchema,
		runtimeBoxId: runtimeBoxIdSchema.optional(),
		expectedPathRevision: projectPathRevisionSchema,
		confirmationToken: projectPreviewConfirmationTokenSchema,
	})
	.strict();
export const relinkProjectOutputSchema = z.object({ project: projectSchema }).strict();

export const validateRuntimeBoxProjectPathInputSchema = z
	.object({ path: projectPathSchema })
	.strict();

export const validateRuntimeBoxProjectPathOutputSchema = z.discriminatedUnion("status", [
	z
		.object({
			status: z.literal("available"),
			normalizedPath: projectPathSchema,
			displayName: projectNameSchema,
			gitRootPath: projectPathSchema.optional(),
			gitBranch: projectGitBranchSchema.optional(),
			rootAgents: projectRootAgentsStatusSchema,
			confirmationToken: projectPreviewConfirmationTokenSchema,
		})
		.strict(),
	z
		.object({
			status: z.literal("unavailable"),
			issueCode: projectPathIssueCodeSchema,
		})
		.strict(),
]);

export const readRuntimeBoxProjectRootAgentsInputSchema = z
	.object({ projectPath: projectPathSchema })
	.strict();

export const readRuntimeBoxProjectRootAgentsOutputSchema = z.discriminatedUnion("status", [
	z.object({ status: z.literal("missing") }).strict(),
	z
		.object({
			status: z.literal("loaded"),
			body: projectRootAgentsBodySchema,
		})
		.strict(),
	z
		.object({
			status: z.literal("warning"),
			issueCode: projectRootAgentsIssueCodeSchema,
		})
		.strict(),
]);

export const createProjectInputSchema = z
	.object({
		runtimeBoxId: runtimeBoxIdSchema.optional(),
		path: projectPathSchema,
		name: projectNameSchema.optional(),
	})
	.strict();

export const createProjectOutputSchema = z.object({ project: projectSchema }).strict();
export const confirmCreateProjectInputSchema = createProjectInputSchema
	.extend({ confirmationToken: projectPreviewConfirmationTokenSchema })
	.strict();
export const confirmCreateProjectOutputSchema = createProjectOutputSchema;

export const listProjectsInputSchema = z
	.object({
		runtimeBoxId: runtimeBoxIdSchema.optional(),
		archived: z.boolean().optional(),
		limit: z.int().min(1).max(200).optional(),
	})
	.strict();

export const listProjectsOutputSchema = z
	.object({ items: z.array(projectSchema).max(200) })
	.strict();

export const getProjectInputSchema = z.object({ projectId: uuidV7Schema }).strict();
export const getProjectOutputSchema = z
	.object({ project: projectSchema, sessionCounts: projectSessionCountsSchema })
	.strict();

export const projectDeleteConfirmationSchema = z
	.object({
		projectId: uuidV7Schema,
		projectName: projectNameSchema,
		sessionCounts: projectSessionCountsSchema,
	})
	.strict();
export const getProjectDeleteConfirmationInputSchema = getProjectInputSchema;
export const getProjectDeleteConfirmationOutputSchema = z
	.object({ confirmation: projectDeleteConfirmationSchema })
	.strict();
export const requestProjectDeletionInputSchema = z
	.object({
		projectId: uuidV7Schema,
		expectedName: projectNameSchema,
	})
	.strict();
export const requestProjectDeletionOutputSchema = z
	.object({
		projectId: uuidV7Schema,
		deletionRequestedAt: isoDateTimeSchema,
	})
	.strict();

export const projectSidebarSessionSummarySchema = z
	.object({
		id: uuidV7Schema,
		title: z.string().trim().min(1).max(200),
		updatedAt: isoDateTimeSchema,
		lastMessageAt: isoDateTimeSchema.optional(),
	})
	.strict();
export const projectSidebarSummarySchema = z
	.object({
		project: projectSchema,
		activeSessionCount: z.int().nonnegative().safe(),
		recentSessions: z.array(projectSidebarSessionSummarySchema).max(8),
	})
	.strict();
export const getProjectSidebarInputSchema = z
	.object({
		runtimeBoxId: runtimeBoxIdSchema.optional(),
	})
	.strict();
export const getProjectSidebarOutputSchema = z
	.object({
		items: z.array(projectSidebarSummarySchema).max(200),
	})
	.strict();

export const updateProjectInputSchema = z
	.object({ projectId: uuidV7Schema, name: projectNameSchema })
	.strict();
export const updateProjectOutputSchema = z.object({ project: projectSchema }).strict();

export const setProjectArchivedInputSchema = z
	.object({ projectId: uuidV7Schema, archived: z.boolean() })
	.strict();
export const setProjectArchivedOutputSchema = z.object({ project: projectSchema }).strict();

export const deleteProjectInputSchema = z.object({ projectId: uuidV7Schema }).strict();
export const deleteProjectOutputSchema = z.object({ deletedProjectId: uuidV7Schema }).strict();

export type Project = z.infer<typeof projectSchema>;
export type ProjectPathStatus = z.infer<typeof projectPathStatusSchema>;
export type ProjectPathIssueCode = z.infer<typeof projectPathIssueCodeSchema>;
export type ProjectPathHealth = z.infer<typeof projectPathHealthSchema>;
export type ProjectRootAgentsIssueCode = z.infer<typeof projectRootAgentsIssueCodeSchema>;
export type ProjectRootAgentsStatus = z.infer<typeof projectRootAgentsStatusSchema>;
export type ProjectPathPreview = z.infer<typeof projectPathPreviewSchema>;
export type PreviewProjectPathInput = z.infer<typeof previewProjectPathInputSchema>;
export type PreviewProjectPathOutput = z.infer<typeof previewProjectPathOutputSchema>;
export type CheckProjectPathInput = z.infer<typeof checkProjectPathInputSchema>;
export type CheckProjectPathOutput = z.infer<typeof checkProjectPathOutputSchema>;
export type PreviewProjectRelinkInput = z.infer<typeof previewProjectRelinkInputSchema>;
export type PreviewProjectRelinkOutput = z.infer<typeof previewProjectRelinkOutputSchema>;
export type RelinkProjectInput = z.infer<typeof relinkProjectInputSchema>;
export type RelinkProjectOutput = z.infer<typeof relinkProjectOutputSchema>;
export type ProjectSessionCounts = z.infer<typeof projectSessionCountsSchema>;
export type ProjectDeleteConfirmation = z.infer<typeof projectDeleteConfirmationSchema>;
export type GetProjectDeleteConfirmationInput = z.infer<
	typeof getProjectDeleteConfirmationInputSchema
>;
export type GetProjectDeleteConfirmationOutput = z.infer<
	typeof getProjectDeleteConfirmationOutputSchema
>;
export type RequestProjectDeletionInput = z.infer<typeof requestProjectDeletionInputSchema>;
export type RequestProjectDeletionOutput = z.infer<typeof requestProjectDeletionOutputSchema>;
export type ProjectSidebarSessionSummary = z.infer<typeof projectSidebarSessionSummarySchema>;
export type ProjectSidebarSummary = z.infer<typeof projectSidebarSummarySchema>;
export type GetProjectSidebarInput = z.infer<typeof getProjectSidebarInputSchema>;
export type GetProjectSidebarOutput = z.infer<typeof getProjectSidebarOutputSchema>;
export type ValidateRuntimeBoxProjectPathInput = z.infer<
	typeof validateRuntimeBoxProjectPathInputSchema
>;
export type ValidateRuntimeBoxProjectPathOutput = z.infer<
	typeof validateRuntimeBoxProjectPathOutputSchema
>;
export type ReadRuntimeBoxProjectRootAgentsInput = z.infer<
	typeof readRuntimeBoxProjectRootAgentsInputSchema
>;
export type ReadRuntimeBoxProjectRootAgentsOutput = z.infer<
	typeof readRuntimeBoxProjectRootAgentsOutputSchema
>;
export type CreateProjectInput = z.infer<typeof createProjectInputSchema>;
export type CreateProjectOutput = z.infer<typeof createProjectOutputSchema>;
export type ConfirmCreateProjectInput = z.infer<typeof confirmCreateProjectInputSchema>;
export type ConfirmCreateProjectOutput = z.infer<typeof confirmCreateProjectOutputSchema>;
export type ListProjectsInput = z.infer<typeof listProjectsInputSchema>;
export type ListProjectsOutput = z.infer<typeof listProjectsOutputSchema>;
export type GetProjectInput = z.infer<typeof getProjectInputSchema>;
export type GetProjectOutput = z.infer<typeof getProjectOutputSchema>;
export type UpdateProjectInput = z.infer<typeof updateProjectInputSchema>;
export type UpdateProjectOutput = z.infer<typeof updateProjectOutputSchema>;
export type SetProjectArchivedInput = z.infer<typeof setProjectArchivedInputSchema>;
export type SetProjectArchivedOutput = z.infer<typeof setProjectArchivedOutputSchema>;
export type DeleteProjectInput = z.infer<typeof deleteProjectInputSchema>;
export type DeleteProjectOutput = z.infer<typeof deleteProjectOutputSchema>;
