export default {
	async fetch(request, env) {
		const allowedOrigins = ['https://knitt.video', 'http://localhost:3000', 'http://127.0.0.1:3000'];

		const origin = request.headers.get('Origin') || '';

		const isAllowedOrigin = allowedOrigins.includes(origin);

		const isDev = request.url.includes('127.0.0.1') || request.url.includes('localhost');

		// ---------- CORS PREFLIGHT ----------
		if (request.method === 'OPTIONS') {
			return new Response(null, {
				headers: corsHeaders(origin, isAllowedOrigin),
			});
		}

		// ---------- ORIGIN CHECK ----------
		if (!isAllowedOrigin) {
			return json({ error: 'Unauthorized' }, 403, origin, false);
		}

		if (request.method !== 'POST') {
			return json({ error: 'Method Not Allowed' }, 405, origin);
		}

		// ---------- BODY ----------
		let body;
		try {
			body = await request.json();
		} catch {
			return json({ error: 'Invalid JSON' }, 400, origin);
		}

		const { email } = body;

		if (!email) {
			return json({ error: 'Email required' }, 400, origin);
		}

		if (!isValidEmail(email)) {
			return json({ error: 'Invalid email format' }, 400, origin);
		}

		try {
			// ---------- DUPLICATE CHECK ----------
			const existing = await env.knitt_waitlist.prepare('SELECT email FROM waitlist WHERE email = ?').bind(email).first();

			if (existing) {
				return json(
					{
						success: true,
						message: "You're already on the waitlist",
					},
					200,
					origin,
				);
			}

			// ---------- DISPOSABLE CHECK ----------
			let isDisposable = false;

			try {
			const res = await fetch(
				`https://disposable.debounce.io/?email=${encodeURIComponent(email)}`
			);

			const contentType = res.headers.get("content-type") || "";

			if (contentType.includes("application/json")) {
				const data = await res.json();

				if (data.disposable === true || data.disposable === "true") {
				isDisposable = true;
				}
			} else {
				console.log("Disposable API returned non-JSON (skipped)");
			}

			} catch (e) {
			console.log("Disposable check failed:", e.message);
			}

			if (isDisposable) {
				return json({ error: 'Disposable emails not allowed' }, 400, origin);
			}

			// ---------- STORE IN D1 ----------
			const now = new Date().toISOString();

			await env.knitt_waitlist.prepare('INSERT INTO waitlist (email, created_at) VALUES (?, ?)').bind(email, now).run();

			// ---------- EMAIL SEND (NON-BLOCKING) ----------
			if (!isDev && env.EMAIL) {
				const html = `
						<div style="margin:0;padding:0;background:#f4f6f8;font-family:Arial, sans-serif;">
							<table width="100%" cellpadding="0" cellspacing="0" style="padding:40px 0;">
							<tr>
								<td align="center">
								<table width="480" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 10px 30px rgba(0,0,0,0.08);">
									
									<!-- Header -->
									<tr>
									<td style="background:#1868db;padding:24px;text-align:center;">
										<h1 style="color:#ffffff;margin:0;font-size:22px;">
										Knitt
										</h1>
									</td>
									</tr>

									<!-- Body -->
									<tr>
									<td style="padding:32px;color:#0d0d0d;">
										<h2 style="margin-top:0;font-size:20px;">
										You're on the waitlist 🎉
										</h2>

										<p style="line-height:1.6;margin:16px 0;">
										Thanks for joining <strong>Knitt</strong>.
										We're building a faster way to explain work with clarity.
										</p>

										<p style="line-height:1.6;margin:16px 0;">
										You'll be among the first to get access when we launch.
										</p>

										<!-- CTA -->
										<div style="margin:28px 0;text-align:center;">
										<a href="https://knitt.video" 
											style="
											display:inline-block;
											padding:12px 20px;
											background:#ffc816;
											color:#0d0d0d;
											text-decoration:none;
											font-weight:bold;
											border-radius:8px;
											font-size:14px;
											">
											Visit Website
										</a>
										</div>

										<p style="font-size:13px;color:#666;margin-top:24px;">
										If you didn’t sign up, you can safely ignore this email.
										</p>
									</td>
									</tr>

									<!-- Footer -->
									<tr>
									<td style="padding:16px;text-align:center;background:#f9fafb;font-size:12px;color:#888;">
										© ${new Date().getFullYear()} Knitt. All rights reserved.
									</td>
									</tr>

								</table>
								</td>
							</tr>
							</table>
						</div>`;

				env.EMAIL.send({
					to: email,
					from: 'Knitt <noreply@knitt.video>',
					subject: "You're on the Knitt waitlist 🎉",
					html,
				}).catch((err) => {
					console.log('Email failed:', err.message);
				});
			} else {
				console.log('DEV MODE: email skipped');
			}

			return json(
				{
					success: true,
					message: 'Added to waitlist',
				},
				200,
				origin,
			);
		} catch (err) {
			console.log('CRASH:', err);

			return json(
				{
					error: 'Server error',
					details: err.message,
				},
				500,
				origin,
			);
		}
	},
};

// ---------- HELPERS ----------

function isValidEmail(email) {
	return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function corsHeaders(origin, allowed = true) {
	return {
		'Access-Control-Allow-Origin': allowed ? origin : 'null',
		'Access-Control-Allow-Methods': 'POST, OPTIONS',
		'Access-Control-Allow-Headers': 'Content-Type',
	};
}

function json(data, status = 200, origin = '*', allowed = true) {
	return new Response(JSON.stringify(data), {
		status,
		headers: {
			'Content-Type': 'application/json',
			...corsHeaders(origin, allowed),
		},
	});
}
