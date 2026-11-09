// @@MOQESH_STAGING_ORIGIN_OWNER@@
export default {
  fetch(request, env) {
    const hostname = new URL(request.url).hostname;
    if (
      hostname !== env.STAGING_HOSTNAME &&
      hostname !== "localhost" &&
      hostname !== "127.0.0.1"
    ) {
      return new Response("Not Found", { status: 404 });
    }
    return env.ASSETS.fetch(request);
  },
};
