export function mergeProjectProgressSnapshot(projectDetails, fullProgress) {
  if (!projectDetails || !fullProgress) return projectDetails;
  return {
    ...projectDetails,
    progress: {
      ...(projectDetails.progress || {}),
      ...fullProgress
    }
  };
}
