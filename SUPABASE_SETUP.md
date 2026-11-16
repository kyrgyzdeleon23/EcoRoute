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
## Publish the website with Render

1. Make sure `.env` is not uploaded. The repository's `.gitignore` excludes it.
   Never put Supabase keys in frontend code or publish them in a repository.
2. Push the project files to a GitHub repository. You can use GitHub Desktop to
   publish the `ecoroute_web` folder if Git is not installed.
3. In the [Render Dashboard](https://dashboard.render.com), choose **New >
   Web Service** and connect the GitHub repository.
4. Configure the service:
   - **Language:** Python 3
   - **Build Command:** `pip install -r requirements.txt`
   - **Start Command:** `gunicorn app:app`
5. In Render's **Environment** settings, add these values from your local `.env`:
   `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, and
   `FLASK_SECRET_KEY`. Set `COOKIE_SECURE` to `true`. Add the values in the
   dashboard; do not commit `.env`.
6. Deploy. Wait for the build to finish, then open the Render-provided
   `https://<service-name>.onrender.com` address and test sign-up, login, and
   request submission.

## Use your own domain

1. Buy a domain from a domain registrar if you do not already own one.
2. In Render, open your web service **Settings > Custom Domains**, choose
   **Add Custom Domain**, and enter your domain (for example,
   `ecoroute.example.com`).
3. At your domain provider, add the DNS records Render displays for that
   domain. Remove conflicting `AAAA` records if Render's instructions require
   it.
4. Return to Render and click **Verify**. Wait until Render verifies the
   domain and provisions HTTPS.
5. In Supabase **Authentication > URL Configuration**, set the **Site URL** to
   your production `https://` domain and add it to the allowed redirect URLs.
6. Open the custom HTTPS domain and test the complete sign-up/login flow.

The generated Render URL can be used without buying a custom domain. Custom
domain availability and hosting prices depend on your Render plan.

The app uses Supabase Auth for accounts and its server-side service-role client
for profiles, requests, audit entries, hubs, and hub connections. The service
role key is never sent to the browser. Row-level security is enabled on the
tables; browser access should continue to go through the Flask API.

For production, set the environment variables in the hosting provider, use a
strong Flask secret, and set `COOKIE_SECURE=true` after HTTPS is enabled. Never
deploy with Flask debug mode enabled.
