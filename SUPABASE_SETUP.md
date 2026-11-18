# Supabase setup and deployment

1. Create a Supabase project.
2. In **Project Settings > API**, copy the project URL, anon key, and service-role key.
   Keep the service-role key private; it must only be used by the Flask server.
3. In **SQL Editor**, run the contents of `supabase_schema.sql`.
4. Copy `.env.example` to `.env` and set the values from your project. Generate a
   long random `FLASK_SECRET_KEY`. Keep `.env` out of version control.
5. Install dependencies locally with `pip install -r requirements.txt`, then
   start the app with `python app.py`.
6. Create an account in the app. If email confirmation is enabled in Supabase,
   confirm the email before logging in.
7. To make an account an administrator, run the commented profile update at the
   end of `supabase_schema.sql`, replacing the email with the administrator's
   email.
## Publish the website with Netlify

1. Push the project to a GitHub repository. Netlify uses the included
   `netlify.toml` to deploy the Flask app as a function and route requests to it.
2. In the [Netlify Dashboard](https://app.netlify.com), choose **Add new site >
   Import an existing project** and connect the repository. Keep the base
   directory and build command empty; the publish directory is `public`.
3. In the site's environment variable settings, add
   `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, and
   `FLASK_SECRET_KEY` using values from your local `.env`. Set
   `COOKIE_SECURE` to `true`. Generate a long random Flask secret, and never
   commit `.env` or expose the Supabase service-role key to frontend code.
4. Deploy the site. Open its `https://<site-name>.netlify.app` URL and test
   sign-up, login, and request submission.
5. In Supabase **Authentication > URL Configuration**, set the **Site URL** to
   the Netlify HTTPS URL and add it to the allowed redirect URLs.

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

The app uses Supabase Auth for accounts and its server-side service-role client
for profiles, requests, audit entries, hubs, and hub connections. The service
role key is never sent to the browser. Row-level security is enabled on the
tables; browser access should continue to go through the Flask API.

For production, set the environment variables in the hosting provider, use a
strong Flask secret, and set `COOKIE_SECURE=true` after HTTPS is enabled. Never
deploy with Flask debug mode enabled.
