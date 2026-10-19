// A redirect may arrive after the first origin consumed a generation POST.
// Neither following it nor exposing Location to a caller preserves the known
// delivery boundary. Endpoint configuration must name the final API address.
export async function rejectGenerationRedirect(response) {
  if (response?.status >= 300 && response.status < 400) {
    await response.body?.cancel().catch(() => {});
    const error = new Error("The upstream redirected a generation request; configure its final API endpoint.");
    error.code = "upstream_redirect_refused";
    error.status = 502;
    throw error;
  }
  return response;
}
