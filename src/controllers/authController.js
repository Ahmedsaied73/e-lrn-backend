const prisma = require("../config/db");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
require('dotenv').config();
const { createToken, createRefreshToken, getCookieConfig } = require('../utils');
const express = require('express');



async function login(req, res) {
    const { email, password } = req.body;
    const user = await prisma.user.findUnique({
        where: {
            email: email
        }
    });

    if (!user) {
        return res.status(404).json({ message: "User not found" });
    }

    // Check if the password is correct
    const passwordMatch = await bcrypt.compare(password, user.password);

    if (!passwordMatch) {
        return res.status(401).json({ message: "Invalid password" });
    }

    // Create a payload with only the necessary user data
    const payload = {
        id: user.id,
        email: user.email,
        name: user.name,
        role: user.role
    };

    // Generate a JWT token
    const token = createToken(payload, process.env.JWTSECRET);
    const refreshToken = createRefreshToken(payload, process.env.JWTSECRET);

    res.json({
        success: true,
        user: payload,
        token: token,
        refreshToken: refreshToken
    });
}

async function register(req, res) {
    const { email, password, name, phoneNumber, grade } = req.body;

    // Validate required fields
    if (!email) {
        return res.status(400).json({ message: "Email is required" });
    }

    if (!password) {
        return res.status(400).json({ message: "Password is required" });
    }

    if (!name) {
        return res.status(400).json({ message: "Name is required" });
    }

    if (!phoneNumber) {
        return res.status(400).json({ message: "Phone number is required" });
    }

    if (!grade) {
        return res.status(400).json({ message: "Grade is required (FIRST_SECONDARY, SECOND_SECONDARY, or THIRD_SECONDARY)" });
    }

    // Validate that grade is one of the allowed values
    const allowedGrades = ['FIRST_SECONDARY', 'SECOND_SECONDARY', 'THIRD_SECONDARY'];
    if (!allowedGrades.includes(grade)) {
        return res.status(400).json({ 
            message: "Invalid grade value. Must be one of: FIRST_SECONDARY, SECOND_SECONDARY, THIRD_SECONDARY" 
        });
    }

    try {
        // Check if the user already exists
        const existingUser = await prisma.user.findUnique({
            where: {
                email: email
            }
        });

        if (existingUser) {
            return res.status(409).json({ message: "User already exists" });
        }

        // Check if phone number is already registered
        const existingPhoneNumber = await prisma.user.findUnique({
            where: {
                phoneNumber: phoneNumber
            }
        });

        if (existingPhoneNumber) {
            return res.status(409).json({ message: "Phone number already registered" });
        }

        // Hash the password
        const hashedPassword = await bcrypt.hash(password, 10);

        // Create a new user
        const newUser = await prisma.user.create({
            data: {
                name: name,
                email: email,
                phoneNumber: phoneNumber,
                password: hashedPassword,
                grade: grade
            }
        });

        // Create a payload with only the necessary user data
        const payload = {
            id: newUser.id,
            email: newUser.email,
            name: newUser.name,
            phoneNumber: newUser.phoneNumber,
            grade: newUser.grade,
            role: newUser.role
        };

        // Generate a JWT token
        const token = createToken(payload, process.env.JWTSECRET);
        const refreshToken = createRefreshToken(payload, process.env.JWTSECRET);

        res.json({
            message: "User registered successfully",
            success: true,
            user: payload,
            token: token,
            refreshToken: refreshToken
        });
    } catch (error) {
        console.error("Registration error:", error);
        res.status(500).json({ message: "An error occurred during registration" });
    }
}


// Logout function to clear cookies
async function logout(req, res) {
    res.json({
        success: true,
        message: "Logged out successfully"
    });
}

// Refresh token function
async function refreshToken(req, res) {
    const refreshToken = req.cookies.refreshToken;
    
    if (!refreshToken) {
        return res.status(401).json({ error: 'Refresh token not provided.' });
    }
    
    try {
        // Verify the refresh token
        const decoded = jwt.verify(refreshToken, process.env.JWTSECRET);
        
        // Create a new payload for the tokens
        const payload = {
            id: decoded.id,
            email: decoded.email,
            name: decoded.name,
            role: decoded.role
        };
        
        // Generate new tokens
        const newToken = createToken(payload, process.env.JWTSECRET);
        const newRefreshToken = createRefreshToken(payload, process.env.JWTSECRET);
        
        res.json({
            success: true,
            message: 'Token refreshed successfully',
            token: newToken,
            refreshToken: newRefreshToken
        });
    } catch (error) {
        console.error('Token refresh error:', error);
        return res.status(401).json({ error: 'Invalid refresh token.' });
    }
}

module.exports = {
    login,
    register,
    logout,
    refreshToken
};