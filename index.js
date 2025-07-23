require('dotenv').config();
const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const FormData = require('form-data');
const axios = require('axios');
const { shopifyApi, LATEST_API_VERSION } = require('@shopify/shopify-api');
require('@shopify/shopify-api/adapters/node');
const xml2js = require('xml2js');
const cors = require("cors");




const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());

const storage = multer.diskStorage({
    destination: function (req, file, cb) {
        cb(null, 'uploads/');
    },
    filename: function (req, file, cb) {
        const ext = path.extname(file.originalname); // get extension (.jpg, .png, etc.)
        const baseName = path.basename(file.originalname, ext);
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, baseName + '-' + uniqueSuffix + ext);
    }
});
// Multer setup for file upload
const upload = multer({ storage });

const shopify = shopifyApi({
    apiKey: process.env.SHOPIFY_API_KEY,
    apiSecretKey: process.env.SHOPIFY_API_SECRET,
    adminApiAccessToken: process.env.ADMIN_API_TOKEN,
    hostName: process.env.SHOPIFY_STORE,
    apiVersion: LATEST_API_VERSION,
    isCustomStoreApp: true,
});

app.post('/upload', upload.single('file'), async (req, res) => {
    try {
        const uploadedFile = req.file;
        const filepath = uploadedFile.path;
        const filename = uploadedFile.originalname;
        const mimetype = uploadedFile.mimetype;

        const client = new shopify.clients.Graphql({
            session: {
                accessToken: process.env.ADMIN_API_TOKEN,
                shop: process.env.SHOPIFY_STORE,
            },
        });

        const mutation = `
            mutation stagedUploadsCreate($input: [StagedUploadInput!]!) {
              stagedUploadsCreate(input: $input) {
                stagedTargets {
                  url
                  resourceUrl
                  parameters {
                    name
                    value
                  }
                }
                userErrors {
                  field
                  message
                }
              }
            }
        `;

        const variables = {
            input: [{
                filename,
                mimeType: mimetype,
                resource: "FILE",
                httpMethod: "POST",
            }]
        };

        const stagedResp = await client.query({
            data: {
                query: mutation,
                variables,
            }
        });

        const { stagedTargets, userErrors } = stagedResp.body.data.stagedUploadsCreate;
        if (userErrors.length > 0) {
            return res.status(400).json({ error: "Staged Upload Error", details: userErrors });
        }

        const target = stagedTargets[0];
        const form = new FormData();
        target.parameters.forEach(p => form.append(p.name, p.value));
        form.append('file', fs.createReadStream(filepath));

        const uploadResp = await axios.post(target.url, form, {
            headers: form.getHeaders(),
            maxBodyLength: Infinity,
        });
        const parsed = await xml2js.parseStringPromise(uploadResp.data);
        const locationUrl = parsed?.PostResponse?.Location?.[0];

        // Clean up uploaded file

        if (uploadResp.status == 201 || uploadResp.status == 299) {
            // Step 2: fileCreate in Shopify
            const fileCreateMutation = `
            mutation fileCreate($files: [FileCreateInput!]!) {
             fileCreate(files: $files) {
                files {
                id
                alt
                preview {
                    image {
                    url
                    }
                }
                }
                userErrors {
                field
                message
                }
            }
            }
        `;
            const fileCreateVars = {
                files: [
                    {
                        originalSource: locationUrl,
                        alt: "Uploaded via API"
                    }
                ]
            };

            const createFileResp = await client.query({
                data: {
                    query: fileCreateMutation,
                    variables: fileCreateVars
                }
            });

            const fileData = createFileResp.body.data.fileCreate;
            if (fileData.userErrors.length > 0) {
                return res.status(400).json({ error: "fileCreate failed", details: fileData.userErrors });
            }
            const fileCreated = fileData.files[0];
            fs.unlinkSync(filepath);
            return res.status(200).json({
                message: "✅ File uploaded & registered with Shopify",
                resourceUrl: locationUrl,
                shopifyFile: fileCreated
            });
        } else {
            return res.status(500).json({ error: '❌ Upload failed', details: uploadResp.data });
        }
    } catch (err) {
        console.error(err);
        return res.status(500).json({ error: 'Internal Server Error', details: err.message });
    }
});

app.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
});
