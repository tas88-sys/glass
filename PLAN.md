# Project Plan: Firebase Integration & Encryption

This document outlines the plan to integrate Firebase Firestore as a remote database for logged-in users and implement end-to-end encryption for user data.

## Phase 1: `encryptionService` and Secure Key Management

The goal of this phase is to create a centralized service for data encryption and decryption, with secure management of encryption keys.

1.  **Install `keytar`**: Add the `keytar` package to the project to securely store encryption keys in the OS keychain.
2.  **Create `encryptionService.js`**:
    -   Location: `src/common/services/encryptionService.js`
    -   Implement `encrypt(text)` and `decrypt(encrypted)` functions using Node.js `crypto` with `AES-256-GCM`.
3.  **Implement Key Management**:
    -   Create an `initializeKey(userId)` function within the service.
    -   This function will first attempt to retrieve the encryption key from `keytar`.
    -   If `keytar` fails or no key is found, it will generate a secure, session-only key in memory as a fallback. It will **not** save the key to an insecure location like `electron-store`.

## Phase 2: Automatic Encryption/Decryption via Firestore Converter

This phase aims to abstract away the encryption/decryption logic from the repository layer, making it automatic.

1.  **Create `firestoreConverter.js`**:
    -   Location: `src/common/repositories/firestoreConverter.js`
    -   Implement a factory function `createEncryptedConverter(fieldsToEncrypt = [])`.
    -   This function will return a Firestore converter object with `toFirestore` and `fromFirestore` methods.
    -   `toFirestore`: Will automatically encrypt the specified fields before writing data to Firestore.
    -   `fromFirestore`: Will automatically decrypt the specified fields after reading data from Firestore.

## Phase 3: Implement Firebase Repositories

With the encryption layer ready, we will create the Firebase equivalents of the existing SQLite repositories.

1.  **Create `session/firebase.repository.js`**:
    -   Location: `src/common/repositories/session/firebase.repository.js`
    -   Use the `createEncryptedConverter` to encrypt fields like `title`.
    -   Implement all functions from the SQLite counterpart (`create`, `getById`, `getOrCreateActive`, etc.) using Firestore APIs.
2.  **Create `ask/repositories/firebase.repository.js`**:
    -   Location: `src/features/ask/repositories/firebase.repository.js`
    -   Use the `createEncryptedConverter` to encrypt the `content` field of AI messages.
    -   Implement all functions from the SQLite counterpart (`addAiMessage`, `getAllAiMessagesBySessionId`).

## Phase 4: Integrate Repository Strategy Pattern

This final phase will activate the logic that switches between local and remote databases based on user authentication status.

1.  **Update `getRepository()` functions**:
    -   Modify `src/common/repositories/session/index.js` and `src/features/ask/repositories/index.js`.
    -   In the `getRepository()` function, use `authService.getCurrentUser()` to check if the user is logged in (`user.isLoggedIn`).
    -   If logged in, return the `firebaseRepository`.
    -   Otherwise, return the `sqliteRepository`.
    -   Uncomment the `require` statements for the newly created Firebase repositories. 