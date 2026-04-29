import {
  CognitoUserPool,
  CognitoUser,
  AuthenticationDetails,
  CognitoUserAttribute,
} from 'amazon-cognito-identity-js';

const pool = new CognitoUserPool({
  UserPoolId: import.meta.env.VITE_COGNITO_USER_POOL_ID,
  ClientId:   import.meta.env.VITE_COGNITO_CLIENT_ID,
});

export function signUp(email, password) {
  return new Promise((resolve, reject) => {
    const attrs = [new CognitoUserAttribute({ Name: 'email', Value: email })];
    pool.signUp(email, password, attrs, null, (err, result) =>
      err ? reject(err) : resolve(result)
    );
  });
}

export function confirmSignUp(email, code) {
  return new Promise((resolve, reject) => {
    new CognitoUser({ Username: email, Pool: pool })
      .confirmRegistration(code, true, (err, result) =>
        err ? reject(err) : resolve(result)
      );
  });
}

export function signIn(email, password) {
  return new Promise((resolve, reject) => {
    new CognitoUser({ Username: email, Pool: pool }).authenticateUser(
      new AuthenticationDetails({ Username: email, Password: password }),
      { onSuccess: resolve, onFailure: reject }
    );
  });
}

export function signOut() {
  pool.getCurrentUser()?.signOut();
}

// Returns the current ID token string (auto-refreshes via refresh token), or null if no session.
export function getIdToken() {
  return new Promise((resolve) => {
    const user = pool.getCurrentUser();
    if (!user) return resolve(null);
    user.getSession((err, session) => {
      resolve(!err && session?.isValid() ? session.getIdToken().getJwtToken() : null);
    });
  });
}
