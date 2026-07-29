import { z } from "zod";
import { isoDateTimeSchema, uuidV7Schema } from "./chat";
import { runtimeBoxIdSchema } from "./runtime-box";

export const projectNameSchema = z.string().trim().min(1).max(128);
export const projectPathSchema = z.string().trim().min(1).max(4_096);

export const projectSchema = z
	.object({
		schemaVersion: z.literal(1),
		id: uuidV7Schema,
		runtimeBoxId: runtimeBoxIdSchema,
		name: projectNameSchema,
		path: projectPathSchema,
		gitRootPath: projectPathSchema.optional(),
		gitBranch: z.string().min(1).max(512).optional(),
		createdAt: isoDateTimeSchema,
		updatedAt: isoDateTimeSchema,
		archivedAt: isoDateTimeSchema.optional(),
	})
	.strict();

export const validateRuntimeBoxProjectPathInputSchema = z
	.object({ path: projectPathSchema })
	.strict();

export const validateRuntimeBoxProjectPathOutputSchema = z
	.object({
		normalizedPath: projectPathSchema,
		displayName: projectNameSchema,
		gitRootPath: projectPathSchema.optional(),
		gitBranch: z.string().min(1).max(512).optional(),
	})
	.strict();

export const createProjectInputSchema = z
	.object({
		runtimeBoxId: runtimeBoxIdSchema.optional(),
		path: projectPathSchema,
		name: projectNameSchema.optional(),
	})
	.strict();

export const createProjectOutputSchema = z.object({ project: projectSchema }).strict();

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
export const getProjectOutputSchema = z.object({ project: projectSchema }).strict();

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
export type ValidateRuntimeBoxProjectPathInput = z.infer<
	typeof validateRuntimeBoxProjectPathInputSchema
>;
export type ValidateRuntimeBoxProjectPathOutput = z.infer<
	typeof validateRuntimeBoxProjectPathOutputSchema
>;
export type CreateProjectInput = z.infer<typeof createProjectInputSchema>;
export type CreateProjectOutput = z.infer<typeof createProjectOutputSchema>;
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
