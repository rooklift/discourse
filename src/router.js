"use strict";

// Sends each participant's requests to the backend for its provider, so the room can treat a
// mixed room as if it had one backend.

function new_router(backends) {
	return {
		backends: backends,

		send: async function(req) {
			let provider = req.participant.provider || "anthropic";
			let backend = backends[provider];
			if (!backend) {
				throw new Error(`No backend for provider "${provider}" (is its API key file set in the config?)`);
			}
			return await backend.send(req);
		},

		is_abort_error: function(error) {
			return Object.values(backends).some(b => b.is_abort_error(error));
		},
	};
}

module.exports = {new_router};
