# Backend — Deploy në Render (falas)

## Hapi -1: Krijo databazën falas (MongoDB Atlas)

1. Shko te [mongodb.com/cloud/atlas/register](https://www.mongodb.com/cloud/atlas/register) → krijo llogari falas
2. Kur të pyesë për "Deploy a database", zgjidh planin **M0 (Free)**
3. Zgjidh një provider/region (default-i është mirë), jepi një emër, **Create**
4. **Krijo user databaze**: kur të kërkojë "Database Access" → krijo username + password (ruaji, të duhen tani)
5. **Lejo aksesin nga Render**: shko te "Network Access" → **Add IP Address** → zgjidh **"Allow access from anywhere"** (0.0.0.0/0) — e domosdoshme sepse Render s'ka IP fikse
6. Shko te "Database" → **Connect** → **Drivers** → kopjo "connection string"-in, duket kështu:
   ```
   mongodb+srv://USERNAME:PASSWORD@cluster0.xxxxx.mongodb.net/?retryWrites=true&w=majority
   ```
7. **Zëvendëso** `USERNAME` dhe `PASSWORD` me ato që krijove në hapin 4, dhe shto emrin e databazës para `?`, p.sh.:
   ```
   mongodb+srv://andi:fjalekalimi@cluster0.xxxxx.mongodb.net/glance?retryWrites=true&w=majority
   ```
   Ruaje këtë varg të plotë — të duhet si `MONGODB_URI` te Hapi 5 poshtë.

## Hapi 0: Krijo "App Password" te Gmail (i domosdoshëm për email verifikimi)

Google s'lejon më aplikacione të dërgojnë email duke përdorur password-in tënd të zakonshëm — duhet një "App Password" i veçantë (16 shkronja).

1. Sigurohu që ke **2-Step Verification** të aktivizuar te llogaria jote Google: shko te myaccount.google.com/security → aktivizoje nëse s'e ke
2. Shko te **myaccount.google.com/apppasswords**
3. Krijo një app password të re (emërtoje p.sh. "glance-backend")
4. Google të jep një kod 16-shkronjash (si `abcd efgh ijkl mnop`) — **kopjoje dhe ruaje diku**, s'do e shohësh më sërish

## Hapi 0.5: Krijo llogari falas Cloudinary (për fotot e profilit)

Fotot tani ngarkohen te Cloudinary (jo direkt te MongoDB si string base64 — kjo ishte problematike sepse e rëndon dhe e ngadalëson databazën).

1. Shko te [cloudinary.com](https://cloudinary.com) → krijo llogari falas (plani falas mjafton gjatë fillimit)
2. Në Dashboard, gjen menjëherë 3 vlerat që të duhen: **Cloud Name**, **API Key**, **API Secret** — kopjoji, të duhen te Hapi 2 poshtë

## Hapi 1: Ngarko këtë folder në GitHub
1. Krijo një repository të ri, bosh, në github.com (p.sh. quaje `glance-backend`)
2. Në terminal, brenda këtij folderi (`backend/`):
   ```
   git init
   git add .
   git commit -m "Glance backend v1"
   git branch -M main
   git remote add origin https://github.com/USERNAME/glance-backend.git
   git push -u origin main
   ```

## Hapi 2: Deploy në Render
1. Shko te [render.com](https://render.com) → krijo llogari falas
2. **New +** → **Web Service**
3. Lidh llogarinë tënde GitHub dhe zgjidh repo `glance-backend`
4. Në settings:
   - **Build Command:** `npm install`
   - **Start Command:** `npm start`
   - **Instance Type:** Free
5. **PARA se të shtypësh "Create"**, shko te seksioni **"Environment Variables"** dhe shto dy variabla (kjo është pika më e rëndësishme e re):
   - `GMAIL_USER` = adresa jote e plotë Gmail (p.sh. `kristinavoja411@gmail.com`)
   - `GMAIL_APP_PASSWORD` = kodi 16-shkronjash nga Hapi 0 (pa hapësira)
   - `JWT_SECRET` = një varg i rastësishëm, i gjatë dhe sekret (p.sh. hap [randomkeygen.com](https://randomkeygen.com) dhe kopjo një "CodeIgniter Encryption Key" — 64 shkronja/numra). **Kjo është "çelësi master"** që nënshkruan sesionet e përdoruesve — mbaje sekret, mos e ndrysho pasi ke përdorues, sepse i çlogon të gjithë
   - `MONGODB_URI` = "connection string"-i i plotë nga Hapi -1
   - `CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY`, `CLOUDINARY_API_SECRET` = 3 vlerat nga Hapi 0.5 (Cloudinary Dashboard)
   - `ALLOWED_ORIGINS` (opsionale, por e rekomanduar): domain-et e sakta që lejohen të thërrasin këtë API nga browser (jo nga app-i mobile — atij s'i duhet), të ndara me presje, p.sh. `https://norviondigital.com,https://tuadomain-lovable.app`. Nëse s'e vendos, API mbetet i hapur për çdo origjinë (më pak i sigurt, por funksional gjatë zhvillimit)
6. Kliko **Create Web Service**

**Pse i vendosim si "Environment Variables" e jo drejt te kodi**: kështu password-i s'shkon kurrë te GitHub (publik) — mbetet vetëm te Render, i fshehur.

Render do të japë një URL si:
```
https://glance-backend-xxxx.onrender.com
```
Kopjoje këtë URL — të duhet te `mobile/constants.js`.

## Nëse e ke tashmë deploy-uar backend-in (rideploy)
Nëse ke bërë tashmë hapat më sipër herë të kaluar, tani duhet vetëm:
1. Shto Environment Variables (Hapi 5 më sipër) te dashboard-i i shërbimit ekzistues në Render (Settings → Environment)
2. `git add . && git commit -m "OTP + siguri" && git push` nga folderi backend — Render rindërton vetë

## Shënim i rëndësishëm
Plani falas i Render "fle" pas ~15 minuta pa trafik dhe i duhen ~30-50 sekonda të zgjohet kur vjen kërkesa e parë. Nëse skanimi i parë "ngec" ose s'kthen përgjigje, prit gjysmë minutë dhe provo sërish — kjo është normale dhe s'është gabim.

## Testim i shpejtë (opsional, para se të lidhësh mobile)
Hap në browser: `https://glance-backend-xxxx.onrender.com/` — duhet të shohësh "Glance API is running."
