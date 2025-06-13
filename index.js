const express = require("express");
const cors = require("cors");
const { MongoClient, ObjectId } = require("mongodb");
require("dotenv").config();
const admin = require("firebase-admin");

const app = express();
const port = process.env.PORT || 5000;

// Initialize Firebase Admin
try {
  // Try to use the service account JSON file
  const serviceAccount = require('./firebase-admin.json');
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
  });
} catch (error) {
  console.error('Error initializing Firebase Admin:', error);
  // If the JSON file is not available, try to use environment variables as fallback
  if (process.env.FIREBASE_SERVICE_ACCOUNT) {
    try {
      const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
      admin.initializeApp({
        credential: admin.credential.cert(serviceAccount)
      });
    } catch (parseError) {
      console.error('Error parsing service account from environment:', parseError);
      throw new Error('Failed to initialize Firebase Admin SDK');
    }
  } else {
    throw new Error('No Firebase credentials available');
  }
}

// Custom error handler middleware
const errorHandler = (err, req, res, next) => {
  console.error('Error:', err);
  
  if (err.name === 'UnauthorizedError' || err.code === 'auth/id-token-expired') {
    return res.status(401).json({ 
      success: false, 
      message: 'Invalid or expired token' 
    });
  }
  
  if (err.code === 'auth/insufficient-permission') {
    return res.status(403).json({ 
      success: false, 
      message: 'Insufficient permissions' 
    });
  }
  
  res.status(500).json({ 
    success: false, 
    message: 'Internal server error' 
  });
};

// Verify Firebase Token Middleware
const verifyToken = async (req, res, next) => {
  try {
    const authHeader = req.headers?.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ 
        success: false, 
        message: "Unauthorized access" 
      });
    }

    const token = authHeader.split(' ')[1];
    try {
      const decodedToken = await admin.auth().verifyIdToken(token);
      req.user = decodedToken;
      next();
    } catch (error) {
      if (error.code === 'auth/id-token-expired') {
        return res.status(401).json({ 
          success: false, 
          message: 'Token expired' 
        });
      }
      throw error;
    }
  } catch (error) {
    next(error);
  }
};

// Verify User Ownership Middleware
const verifyOwnership = async (req, res, next) => {
  try {
    const userEmail = req.user.email;
    const artifact = await artifactsCollection.findOne({ 
      _id: new ObjectId(req.params.id) 
    });
    
    if (!artifact) {
      return res.status(404).json({ 
        success: false, 
        message: 'Artifact not found' 
      });
    }
    
    if (artifact.adderEmail !== userEmail) {
      return res.status(403).json({ 
        success: false, 
        message: 'You do not have permission to modify this artifact' 
      });
    }
    
    req.artifact = artifact;
    next();
  } catch (error) {
    next(error);
  }
};

app.use(cors());
app.use(express.json());

// Apply error handler
app.use(errorHandler);

// Test authentication endpoint
app.get("/api/test-auth", verifyToken, async (req, res) => {
  try {
    // Return user info from the verified token
    res.json({
      message: "Authentication successful",
      user: {
        email: req.user.email,
        uid: req.user.uid,
        emailVerified: req.user.email_verified
      }
    });
  } catch (error) {
    console.error("Test auth error:", error);
    res.status(500).json({ message: "Internal server error" });
  }
});

const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASS}@ph-cluster.8kwdmtt.mongodb.net/?retryWrites=true&w=majority&appName=PH-Cluster`;
const client = new MongoClient(uri, {
  useNewUrlParser: true,
  useUnifiedTopology: true,
});

async function run() {
  try {
    await client.connect();
    console.log("Connected to MongoDB");

    const db = client.db("artifactsDB");
    const artifactsCollection = db.collection("artifacts");

    // Drop existing text index if it exists and create a new one
    try {
        await artifactsCollection.dropIndex("name_text_description_text_type_text_presentLocation_text");
    } catch (error) {
        console.log("No existing text index to drop");
    }

    // Create text index for search functionality
    await artifactsCollection.createIndex(
        { 
            name: "text", 
            description: "text", 
            type: "text", 
            presentLocation: "text" 
        },
        { 
            weights: {
                name: 10,
                type: 5,
                presentLocation: 5,
                description: 1
            },
            name: "artifact_search_index"
        }
    );

    // GET: Search artifacts
    app.get("/api/artifacts/search", async (req, res) => {
        try {
            const searchQuery = req.query.q;
            console.log("Search query received:", searchQuery);
            
            if (!searchQuery || searchQuery.trim() === '') {
                return res.json([]);
            }

            // Create a regex pattern for case-insensitive search
            const searchRegex = new RegExp(searchQuery, 'i');

            // Use $or to search across multiple fields
            const result = await artifactsCollection.find({
                $or: [
                    { name: searchRegex },
                    { description: searchRegex },
                    { type: searchRegex },
                    { presentLocation: searchRegex }
                ]
            }).toArray();

            console.log(`Found ${result.length} results for query: ${searchQuery}`);
            
            res.json(result);
        } catch (error) {
            console.error("Error searching artifacts:", error);
            res.status(500).json({
                success: false,
                message: "Failed to search artifacts",
                error: error.message
            });
        }
    });

    // GET: Get top liked artifacts (MUST be before other artifact routes)
    app.get("/api/artifacts/top-liked", async (req, res) => {
      try {
        const result = await artifactsCollection.aggregate([
          { $sort: { likeCount: -1 } },
          { $limit: 6 }
        ]).toArray();
        
        return res.json(result);
      } catch (error) {
        console.error('Error in top-liked:', error);
        return res.status(500).json({ message: 'Server error' });
      }
    });

    // POST: Add a new artifact (Protected)
    app.post("/api/artifacts", verifyToken, async (req, res) => {
      try {
        const artifact = req.body;
        // Add likeCount, timestamp and verified user info
        artifact.likeCount = 0;
        artifact.addedDate = new Date();
        artifact.adderEmail = req.user.email; // From verified token

        const result = await artifactsCollection.insertOne(artifact);
        res.status(201).json({
          success: true,
          message: "Artifact added successfully",
          insertedId: result.insertedId,
        });
      } catch (error) {
        console.error("Error adding artifact:", error);
        res.status(500).json({
          success: false,
          message: "Failed to add artifact",
        });
      }
    });

    // GET: Get all artifacts
    app.get("/api/artifacts", async (req, res) => {
      try {
        const artifacts = await artifactsCollection.find().toArray();
        res.json(artifacts);
      } catch (error) {
        console.error("Error fetching artifacts:", error);
        res.status(500).json({
          success: false,
          message: "Failed to fetch artifacts",
        });
      }
    });

    // GET: Get single artifact by ID
    app.get("/api/artifacts/:id", async (req, res) => {
      try {
        const id = req.params.id;

        if (!ObjectId.isValid(id)) {
          return res.status(400).json({
            success: false,
            message: "Invalid artifact ID format"
          });
        }

        const artifact = await artifactsCollection.findOne({
          _id: new ObjectId(id)
        });

        if (!artifact) {
          return res.status(404).json({
            success: false,
            message: "Artifact not found"
          });
        }

        res.status(200).json(artifact);
      } catch (error) {
        console.error("Error fetching artifact:", error);
        res.status(500).json({
          success: false,
          message: "Failed to fetch artifact",
          error: error.message
        });
      }
    });

    // PATCH: Update like count (Protected)
    app.patch("/api/artifacts/:id/like", verifyToken, async (req, res) => {
      try {
        const id = req.params.id;
        const userEmail = req.user.email; // From verified token

        const result = await artifactsCollection.updateOne(
          { _id: new ObjectId(id) },
          {
            $inc: { likeCount: 1 },
            $addToSet: { likedBy: userEmail },
          }
        );

        if (result.modifiedCount === 0) {
          return res.status(404).json({
            success: false,
            message: "Artifact not found",
          });
        }

        res.json({
          success: true,
          message: "Like count updated successfully",
        });
      } catch (error) {
        console.error("Error updating like count:", error);
        res.status(500).json({
          success: false,
          message: "Failed to update like count",
        });
      }
    });

    // PATCH: Update dislike (Protected)
    app.patch("/api/artifacts/:id/dislike", verifyToken, async (req, res) => {
      try {
        const id = req.params.id;
        const userEmail = req.user.email; // From verified token

        // First get the current like count and check if user has liked
        const artifact = await artifactsCollection.findOne({
          _id: new ObjectId(id),
        });

        if (!artifact) {
          return res.status(404).json({
            success: false,
            message: "Artifact not found",
          });
        }

        // Only decrease if like count is greater than 0 and user has liked
        if (artifact.likeCount > 0 && artifact.likedBy?.includes(userEmail)) {
          const result = await artifactsCollection.updateOne(
            { _id: new ObjectId(id) },
            {
              $inc: { likeCount: -1 },
              $pull: { likedBy: userEmail },
            }
          );

          if (result.modifiedCount === 0) {
            return res.status(404).json({
              success: false,
              message: "Artifact not found",
            });
          }
        }

        res.json({
          success: true,
          message: "Like count updated successfully",
        });
      } catch (error) {
        console.error("Error updating like count:", error);
        res.status(500).json({
          success: false,
          message: "Failed to update like count",
        });
      }
    });

    // GET: Get user's liked artifacts (Protected)
    app.get("/api/artifacts/liked/:userEmail", verifyToken, async (req, res) => {
      try {
        const userEmail = req.user.email; // From verified token
        const likedArtifacts = await artifactsCollection
          .find({ likedBy: userEmail })
          .toArray();

        res.json(likedArtifacts);
      } catch (error) {
        console.error("Error fetching liked artifacts:", error);
        res.status(500).json({
          success: false,
          message: "Failed to fetch liked artifacts",
        });
      }
    });

    // GET: Get artifacts by user email (Protected)
    app.get("/api/artifacts/user/:email", verifyToken, async (req, res) => {
      try {
        const email = req.user.email; // From verified token
        
        const artifacts = await artifactsCollection
          .find({ adderEmail: email })
          .toArray();

        console.log(`Found ${artifacts.length} artifacts for user ${email}`);
        
        return res.status(200).json(artifacts);
      } catch (error) {
        console.error("Error fetching user artifacts:", error);
        return res.status(500).json({
          success: false,
          message: "Failed to fetch user artifacts"
        });
      }
    });

    // PATCH: Update an artifact (Protected)
    app.patch("/api/artifacts/:id", verifyToken, async (req, res) => {
      try {
        const id = req.params.id;
        const updates = req.body;
        const userEmail = req.user.email; // From verified token

        // First check if the user owns this artifact
        const artifact = await artifactsCollection.findOne({
          _id: new ObjectId(id),
          adderEmail: userEmail
        });

        if (!artifact) {
          return res.status(403).json({
            success: false,
            message: "You don't have permission to update this artifact"
          });
        }

        // Remove any fields that shouldn't be updated
        delete updates.likeCount;
        delete updates.likedBy;
        delete updates.adderName;
        delete updates.adderEmail;

        const result = await artifactsCollection.updateOne(
          { _id: new ObjectId(id) },
          { $set: updates }
        );

        if (result.matchedCount === 0) {
          return res.status(404).json({
            success: false,
            message: "Artifact not found"
          });
        }

        res.json({
          success: true,
          message: "Artifact updated successfully"
        });
      } catch (error) {
        console.error("Error updating artifact:", error);
        res.status(500).json({
          success: false,
          message: "Failed to update artifact"
        });
      }
    });

    // DELETE: Delete an artifact (Protected)
    app.delete("/api/artifacts/:id", verifyToken, async (req, res) => {
      try {
        const id = req.params.id;
        const userEmail = req.user.email; // From verified token

        // First check if the user owns this artifact
        const artifact = await artifactsCollection.findOne({
          _id: new ObjectId(id),
          adderEmail: userEmail
        });

        if (!artifact) {
          return res.status(403).json({
            success: false,
            message: "You don't have permission to delete this artifact"
          });
        }

        const result = await artifactsCollection.deleteOne({
          _id: new ObjectId(id)
        });

        if (result.deletedCount === 0) {
          return res.status(404).json({
            success: false,
            message: "Artifact not found"
          });
        }

        res.json({
          success: true,
          message: "Artifact deleted successfully"
        });
      } catch (error) {
        console.error("Error deleting artifact:", error);
        res.status(500).json({
          success: false,
          message: "Failed to delete artifact"
        });
      }
    });

    app.get("/", (req, res) => {
      res.send("Artifacts Server is running!");
    });
  } catch (err) {
    console.error(err);
  }
}

run().catch(console.dir);

app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});
