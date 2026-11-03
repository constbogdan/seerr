export const serializeLibraryQuery = (params: URLSearchParams) => {
  params.sort();
  return params.toString().replace(/\+/g, '%20');
};
