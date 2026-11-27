# Supabase setup and deployment

1. Create a Supabase project.
2. In **Project Settings > API**, copy the project URL, anon key, and service-role key.
   Keep the service-role key private; it must only be used by the server-side API.
3. In **SQL Editor**, run the contents of `supabase_schema.sql`.
4. Copy `.env.example` to `.env` and set the values from your project. Generate a
   long random `FLASK_SECRET_KEY`. Keep `.env` out of version control.
5. To run the original Python version locally, install dependencies with
   `pip install -r requirements.txt`, then start it with `python app.py`.
   The deployed Netlify version uses the Node.js API in
   `netlify/functions/api.mjs`.
6. Create an account in the app. If email confirmation is enabled in Supabase,
   confirm the email before logging in.
7. To make an account an administrator, run the commented profile update at the
   end of `supabase_schema.sql`, replacing the email with the administrator's
   email.

Password reset links are sent by Supabase Auth. Configure the project's email
provider and Site URL under **Authentication > URL Configuration**; the Site URL
must point to the deployed app. If the project was set up before pickup dispatch
was added, rerun `supabase_schema.sql` to create and seed the shared
`app_settings` row.
## Publish the website with Netlify

1. Push the project to a GitHub repository. Netlify uses the included
   `netlify.toml` to build the static frontend and deploy its Node.js API
   function. The Netlify deployment does not run Flask or Python functions.
2. In the [Netlify Dashboard](https://app.netlify.com), choose **Add new site >
   Import an existing project** and connect the repository. Leave the base
   directory blank. The build command (`npm run build`) and publish directory
   (`dist`) are set in `netlify.toml`.
3. In the site's environment variable settings, add
   `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, and
   `FLASK_SECRET_KEY` using values from your local `.env`. `FLASK_SECRET_KEY`
   signs the app's login cookie; use a long random value. Set `COOKIE_SECURE`
   to `true`. Make the variables available to Netlify Functions. Never commit
   `.env` or expose the Supabase service-role key to frontend code.
4. Deploy the site. Open its `https://<site-name>.netlify.app` URL and test
   sign-up, login, and request submission.
5. In Supabase **Authentication > URL Configuration**, set the **Site URL** to
   the Netlify HTTPS URL and add it to the allowed redirect URLs.

To check the Node.js deployment locally, install Node.js 22 or later, then run
`npm run build` and `npm test`. You can use Netlify CLI's `netlify dev` command
to test the built site and API together.

## Use your own domain

1. Buy a domain from a domain registrar if you do not already own one.
2. In Netlify, open the site's **Domain management** settings and add your
   custom domain.
3. At your domain provider, add the DNS records Netlify displays. Wait for
   Netlify to verify the domain and provision HTTPS.
4. In Supabase **Authentication > URL Configuration**, set the **Site URL** to
   your production `https://` domain and add it to the allowed redirect URLs.
5. Open the custom HTTPS domain and test the complete sign-up/login flow.

The generated Netlify URL can be used without buying a custom domain. Custom
domain availability and hosting prices depend on your Netlify plan.

The app uses Supabase Auth for accounts and its server-side service-role key
for profiles, requests, audit entries, hubs, and hub connections. The service
role key is never sent to the browser. Row-level security is enabled on the
tables; browser access should continue to go through the Node.js API.

For production, set the environment variables in the hosting provider, use a
strong cookie-signing secret, and set `COOKIE_SECURE=true` after HTTPS is
enabled. Never deploy `.env` or use development secrets.
